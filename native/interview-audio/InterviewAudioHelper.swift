// A read-only system-output stream. Never attach a microphone or screen output.
// Stdout is a private bounded NDJSON pipe to Electron, not a transcript log.
import Foundation
import AppKit
import ScreenCaptureKit
import Speech
import AVFoundation
import CoreMedia
import Darwin

final class ProtocolWriter: @unchecked Sendable {
    private let lock = NSLock()
    func send(_ value: [String: Any]) {
        guard JSONSerialization.isValidJSONObject(value),
              var data = try? JSONSerialization.data(withJSONObject: value), data.count < 16_384 else { return }
        data.append(0x0A)
        lock.lock()
        defer { lock.unlock() }
        // A closed owner pipe must never become an audio/transcript file.
        do { try FileHandle.standardOutput.write(contentsOf: data) }
        catch { Darwin.exit(0) }
    }
}

enum HelperFailure: Error {
    case code(String)
    var code: String { switch self { case .code(let value): return value } }
}

@available(macOS 26.0, *)
final class AudioOutput: NSObject, SCStreamOutput, @unchecked Sendable {
    let queue = DispatchQueue(label: "interview-audio.samples", qos: .userInitiated)
    private let analyzer: SpeechAnalyzer
    private let format: AVAudioFormat
    private let input: AsyncStream<AnalyzerInput>.Continuation
    private let writer: ProtocolWriter
    private let fail: @Sendable (String) -> Void
    private var converter: AVAudioConverter?
    private var sourceFormat: AVAudioFormat?
    private var samplePosition: Int64 = 0
    private var lastVoicedAt: TimeInterval = -.infinity
    private var finalizedVoiceAt: TimeInterval = -.infinity
    private var stopped = false
    private var paused = true
    private var activeStreamID: ObjectIdentifier?
    private var timer: DispatchSourceTimer?

    init(analyzer: SpeechAnalyzer, format: AVAudioFormat,
         input: AsyncStream<AnalyzerInput>.Continuation, writer: ProtocolWriter,
         fail: @escaping @Sendable (String) -> Void) {
        self.analyzer = analyzer; self.format = format; self.input = input
        self.writer = writer; self.fail = fail
        super.init()
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now(), repeating: .milliseconds(100))
        timer.setEventHandler { [weak self] in self?.tick() }
        self.timer = timer
        timer.resume()
    }

    func stop() async {
        await withCheckedContinuation { continuation in
            queue.async {
                self.stopped = true
                self.timer?.cancel(); self.timer = nil
                self.converter = nil; self.sourceFormat = nil
                self.input.finish()
                continuation.resume()
            }
        }
    }

    func beginStream(_ stream: SCStream) async {
        await withCheckedContinuation { continuation in
            queue.async {
                if !self.stopped {
                    self.activeStreamID = ObjectIdentifier(stream)
                    self.paused = false
                    self.converter = nil; self.sourceFormat = nil
                }
                continuation.resume()
            }
        }
    }

    func pauseAndGetBoundary() async -> CMTime {
        await withCheckedContinuation { continuation in
            queue.async {
                self.paused = true; self.activeStreamID = nil
                self.lastVoicedAt = -.infinity; self.finalizedVoiceAt = -.infinity
                continuation.resume(returning: CMTime(value: self.samplePosition,
                    timescale: CMTimeScale(self.format.sampleRate)))
            }
        }
    }

    private func tick() {
        guard !stopped, !paused else { return }
        let quietFor = ProcessInfo.processInfo.systemUptime - lastVoicedAt
        writer.send(["type": "activity", "speaking": quietFor < 0.18])
        // Finalize the current range without ending the long-lived analyzer.
        // Otherwise a volatile range could span two questions after a pause.
        if quietFor >= 0.65, lastVoicedAt.isFinite, lastVoicedAt > finalizedVoiceAt {
            finalizedVoiceAt = lastVoicedAt
            let through = CMTime(value: samplePosition, timescale: CMTimeScale(format.sampleRate))
            Task {
                do { try await analyzer.finalize(through: through) }
                catch { if !Task.isCancelled { fail("recognition-failed") } }
            }
        }
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
                of outputType: SCStreamOutputType) {
        guard !stopped, !paused, activeStreamID == ObjectIdentifier(stream),
              outputType == .audio, sampleBuffer.isValid,
              let description = sampleBuffer.formatDescription,
              let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(description),
              let incomingFormat = AVAudioFormat(streamDescription: asbd) else { return }
        let frameCount = CMSampleBufferGetNumSamples(sampleBuffer)
        guard frameCount > 0, frameCount <= 96_000,
              let source = AVAudioPCMBuffer(pcmFormat: incomingFormat, frameCapacity: AVAudioFrameCount(frameCount)) else { return }
        source.frameLength = AVAudioFrameCount(frameCount)
        guard CMSampleBufferCopyPCMDataIntoAudioBufferList(sampleBuffer, at: 0,
            frameCount: Int32(frameCount), into: source.mutableAudioBufferList) == noErr else {
            fail("capture-failed"); return
        }
        // Device changes may change sample format. Recreate only a software
        // converter; never enumerate, configure or select a hardware device.
        if sourceFormat != incomingFormat {
            sourceFormat = incomingFormat
            converter = AVAudioConverter(from: incomingFormat, to: format)
            converter?.primeMethod = .none
        }
        guard let converter else { fail("capture-failed"); return }
        let capacity = AVAudioFrameCount(ceil(Double(frameCount) * format.sampleRate / incomingFormat.sampleRate) + 64)
        guard let converted = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else { return }
        var supplied = false
        var conversionError: NSError?
        let status = converter.convert(to: converted, error: &conversionError) { _, outStatus in
            if supplied { outStatus.pointee = .noDataNow; return nil }
            supplied = true; outStatus.pointee = .haveData; return source
        }
        guard conversionError == nil, status != .error else { fail("capture-failed"); return }
        guard converted.frameLength > 0 else { return }
        if Self.rms(converted) > 0.0025 { lastVoicedAt = ProcessInfo.processInfo.systemUptime }
        let startTime = CMTime(value: samplePosition, timescale: CMTimeScale(format.sampleRate))
        samplePosition += Int64(converted.frameLength)
        switch input.yield(AnalyzerInput(buffer: converted, bufferStartTime: startTime)) {
        case .dropped: fail("recognition-failed") // Never silently lose speech.
        default: break
        }
    }

    private static func rms(_ buffer: AVAudioPCMBuffer) -> Float {
        let count = Int(buffer.frameLength)
        guard count > 0 else { return 0 }
        var sum: Float = 0
        for index in 0..<count {
            let value: Float
            if let data = buffer.floatChannelData { value = data[0][index] }
            else if let data = buffer.int16ChannelData { value = Float(data[0][index]) / 32768 }
            else if let data = buffer.int32ChannelData { value = Float(data[0][index]) / 2_147_483_648 }
            else { return 0 }
            sum += value * value
        }
        return sqrt(sum / Float(count))
    }
}

@available(macOS 26.0, *)
@MainActor final class CaptureSession: NSObject, SCStreamDelegate {
    private let parentPID: pid_t
    private let locale: Locale
    private let writer: ProtocolWriter
    private let finish: AsyncStream<String>.Continuation
    private var analyzer: SpeechAnalyzer?
    private var audio: AudioOutput?
    private var stream: SCStream?
    private var resultsTask: Task<Void, Never>?
    private var parentTimer: DispatchSourceTimer?
    private var stopped = false
    private var restartCount = 0
    private var restarting = false
    private var captureStartedAt: TimeInterval = 0
    private var acceptingResults = true
    private var acceptResultsFromMs = 0

    init(parentPID: pid_t, locale: Locale, writer: ProtocolWriter,
         finish: AsyncStream<String>.Continuation) {
        self.parentPID = parentPID; self.locale = locale; self.writer = writer; self.finish = finish
    }

    func start() async {
        writer.send(["type": "status", "state": "preparing"])
        do {
            guard SpeechTranscriber.isAvailable,
                  let supportedLocale = await SpeechTranscriber.supportedLocale(equivalentTo: locale) else {
                throw HelperFailure.code("unsupported-locale")
            }
            let transcriber = SpeechTranscriber(locale: supportedLocale, transcriptionOptions: [],
                reportingOptions: [.volatileResults, .fastResults], attributeOptions: [])
            // Only language-model assets may be downloaded. There is no audio
            // source or permission request until installation has completed.
            if await AssetInventory.status(forModules: [transcriber]) != .installed {
                do {
                    if let install = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
                        try await install.downloadAndInstall()
                    } else if await AssetInventory.status(forModules: [transcriber]) != .installed {
                        throw HelperFailure.code("speech-assets")
                    }
                } catch { throw HelperFailure.code("speech-assets") }
            }
            try Task.checkCancellation()
            guard !stopped, await AssetInventory.status(forModules: [transcriber]) == .installed,
                  let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]) else {
                throw HelperFailure.code("speech-assets")
            }
            let analyzer = SpeechAnalyzer(modules: [transcriber], options: .init(priority: .userInitiated, modelRetention: .whileInUse))
            self.analyzer = analyzer
            try await analyzer.prepareToAnalyze(in: format)
            try Task.checkCancellation()
            guard !stopped else { return }
            let (inputs, continuation) = AsyncStream<AnalyzerInput>.makeStream(bufferingPolicy: .bufferingNewest(100))
            audio = AudioOutput(analyzer: analyzer, format: format, input: continuation, writer: writer) { [weak self] code in
                Task { @MainActor in self?.fail(code) }
            }
            resultsTask = Task { [weak self] in
                do {
                    for try await result in transcriber.results {
                        guard let self, !self.stopped, !Task.isCancelled else { return }
                        guard self.acceptingResults else { continue }
                        let text = String(result.text.characters).trimmingCharacters(in: .whitespacesAndNewlines)
                        guard !text.isEmpty else { continue }
                        guard text.count <= 4000 else { self.fail("recognition-failed"); return }
                        let start = result.range.start.seconds
                        let end = CMTimeRangeGetEnd(result.range).seconds
                        guard start.isFinite, end.isFinite, start >= 0, end >= start,
                              end < Double(Int.max / 1000) else { self.fail("recognition-failed"); return }
                        let startMs = Int((start * 1000).rounded())
                        let endMs = Int((end * 1000).rounded())
                        guard startMs >= self.acceptResultsFromMs else { continue }
                        self.writer.send(["type": "transcript", "text": text, "segmentId": String(startMs),
                            "final": result.isFinal, "startMs": startMs, "endMs": endMs])
                    }
                } catch { if !Task.isCancelled { self?.fail("recognition-failed") } }
            }
            try await analyzer.start(inputSequence: inputs)
            try Task.checkCancellation()
            guard !stopped else { return }
            try await startCapture()
            try Task.checkCancellation()
            guard !stopped else { return }
            writer.send(["type": "status", "state": "listening"])
            let timer = DispatchSource.makeTimerSource(queue: .main)
            timer.schedule(deadline: .now() + .seconds(1), repeating: .seconds(1))
            timer.setEventHandler { [weak self] in
                Task { @MainActor in
                    guard let self else { return }
                    if Darwin.kill(self.parentPID, 0) != 0 && errno != EPERM { self.finish.yield("parent-exited") }
                }
            }
            parentTimer = timer; timer.resume()
        } catch is CancellationError {
            finish.yield("stopped")
        } catch let failure as HelperFailure { fail(failure.code) }
        catch { fail(Self.captureErrorCode(error)) }
    }

    private func startCapture() async throws {
        // Explicit all-windows enumeration: the call need not be frontmost or
        // visible in this Space. Only the audio output is attached below.
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        try Task.checkCancellation()
        guard !stopped, let display = content.displays.first, let audio else { throw HelperFailure.code("capture-failed") }
        let hostBundle = NSRunningApplication(processIdentifier: parentPID)?.bundleIdentifier
        let helperBundle = Bundle.main.bundleIdentifier ?? "com.antigravity.infinitecanvas.interview-audio"
        let excluded = content.applications.filter { app in
            app.processID == parentPID || app.processID == getpid()
            || app.bundleIdentifier == helperBundle
            || (hostBundle != nil && (app.bundleIdentifier == hostBundle || app.bundleIdentifier.hasPrefix(hostBundle! + ".")))
        }
        let filter = SCContentFilter(display: display, excludingApplications: excluded, exceptingWindows: [])
        let config = SCStreamConfiguration()
        config.capturesAudio = true
        config.captureMicrophone = false
        config.excludesCurrentProcessAudio = true
        config.sampleRate = 48_000; config.channelCount = 1
        config.width = 2; config.height = 2
        config.minimumFrameInterval = CMTime(value: 1, timescale: 1)
        config.queueDepth = 3
        let candidate = SCStream(filter: filter, configuration: config, delegate: self)
        try candidate.addStreamOutput(audio, type: .audio, sampleHandlerQueue: audio.queue)
        stream = candidate
        await audio.beginStream(candidate)
        try Task.checkCancellation()
        guard !stopped else { throw CancellationError() }
        try await candidate.startCapture()
        if stopped || Task.isCancelled { try? await candidate.stopCapture(); throw CancellationError() }
        captureStartedAt = ProcessInfo.processInfo.systemUptime
    }

    nonisolated func stream(_ stream: SCStream, didStopWithError error: Error) {
        Task { @MainActor [weak self] in
            guard let self, !self.stopped, self.stream === stream, !self.restarting else { return }
            if Self.captureErrorCode(error) == "permission-denied" { self.fail("permission-denied"); return }
            // Restart only the read-only stream after an OS interruption. The
            // existing analyzer/converter accepts any new PCM format.
            if ProcessInfo.processInfo.systemUptime - self.captureStartedAt > 10 { self.restartCount = 0 }
            guard self.restartCount < 2 else { self.fail("capture-failed"); return }
            self.restartCount += 1; self.restarting = true
            self.acceptingResults = false
            self.writer.send(["type": "status", "state": "preparing"])
            do {
                if let audio = self.audio, let analyzer = self.analyzer {
                    let boundary = await audio.pauseAndGetBoundary()
                    self.acceptResultsFromMs = Int((boundary.seconds * 1000).rounded())
                    // Finalize only while results are suppressed. Cancellation
                    // retires the old range without resetting the input clock.
                    if boundary.value > 0 {
                        try await analyzer.finalize(through: boundary)
                        await analyzer.cancelAnalysis(before: boundary)
                    }
                }
                try await self.startCapture()
                self.restarting = false
                self.acceptingResults = true
                if !self.stopped { self.writer.send(["type": "status", "state": "listening"]) }
            } catch {
                self.restarting = false
                if !self.stopped { self.fail(Self.captureErrorCode(error)) }
            }
        }
    }

    private static func captureErrorCode(_ error: Error) -> String {
        let native = error as NSError
        return native.domain == SCStreamErrorDomain && native.code == -3801 ? "permission-denied" : "capture-failed"
    }

    private func fail(_ code: String) {
        guard !stopped else { return }
        writer.send(["type": "error", "code": code])
        finish.yield("failed")
    }

    func stop() async {
        guard !stopped else { return }
        stopped = true
        parentTimer?.cancel(); parentTimer = nil
        let activeStream = stream; stream = nil
        try? await activeStream?.stopCapture()
        await audio?.stop(); audio = nil
        resultsTask?.cancel(); resultsTask = nil
        await analyzer?.cancelAndFinishNow(); analyzer = nil
    }
}

@main enum InterviewAudioHelper {
    static func main() async {
        let writer = ProtocolWriter()
        let arguments = Array(CommandLine.arguments.dropFirst())
        guard arguments.count == 4, arguments[0] == "--parent-pid", arguments[2] == "--locale",
              let pid = Int32(arguments[1]), pid > 1, pid == getppid(), arguments[3] == "en-US" else {
            writer.send(["type": "error", "code": "capture-failed"]); return
        }
        guard #available(macOS 26.0, *) else {
            writer.send(["type": "error", "code": "unsupported-platform"]); return
        }
        signal(SIGPIPE, SIG_IGN)
        signal(SIGTERM, SIG_IGN)
        signal(SIGINT, SIG_IGN)
        let (terminations, finish) = AsyncStream<String>.makeStream(bufferingPolicy: .bufferingNewest(1))
        let term = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .global())
        let interrupt = DispatchSource.makeSignalSource(signal: SIGINT, queue: .global())
        term.setEventHandler { finish.yield("stopped") }; term.resume()
        interrupt.setEventHandler { finish.yield("stopped") }; interrupt.resume()
        // EOF also handles owner crashes without depending on PID reuse.
        DispatchQueue.global(qos: .utility).async {
            while let line = readLine() { if line == "stop" { break } }
            finish.yield("stopped")
        }
        let session = CaptureSession(parentPID: pid, locale: Locale(identifier: "en-US"), writer: writer, finish: finish)
        let startup = Task { await session.start() }
        for await _ in terminations { break }
        startup.cancel()
        await session.stop()
        finish.finish(); term.cancel(); interrupt.cancel()
    }
}
