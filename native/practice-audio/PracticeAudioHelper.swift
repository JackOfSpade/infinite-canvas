// Interview practice call audio: microphone capture, voice-processed playback
// (one shared AVAudioEngine so the echo canceller has the playback reference),
// on-device transcription and a local 16 kHz WAV recording.
// Stdout is a private bounded NDJSON pipe to Electron, not a transcript log.
// Transcript text is never written to stderr, a file or anywhere but stdout.
import Foundation
import AppKit
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

/// Every VAD tuning constant lives here; Phase 3 tunes these values.
struct PracticeVadTuning {
    /// Analysis window for energy measurement.
    static let windowMs: Double = 10
    /// Speech starts after this much continuous energy above the threshold.
    static let startHoldMs: Double = 100
    /// Speech ends after this much continuous energy below the threshold.
    static let endHoldMs: Double = 200
    /// Threshold = max(absoluteMinThreshold, noiseFloor * thresholdRatio) (linear RMS).
    static let thresholdRatio: Float = 3.0
    static let absoluteMinThreshold: Float = 0.006
    static let initialNoiseFloor: Float = 0.002
    static let minNoiseFloor: Float = 0.0003
    static let maxNoiseFloor: Float = 0.05
    /// Per-window adaptation of the floor (falls fast, rises slowly).
    static let noiseFloorFallRate: Float = 0.1
    static let noiseFloorRiseRate: Float = 0.003
}

/// Energy VAD with an adaptive noise floor. Times are timeline milliseconds;
/// the reported time is the onset/offset of the run, not the detection time.
struct EnergyVad {
    private(set) var speaking = false
    private var noiseFloor = PracticeVadTuning.initialNoiseFloor
    private var aboveMs = 0.0
    private var belowMs = 0.0
    private var runStartMs = 0.0

    mutating func reset() { speaking = false; aboveMs = 0; belowMs = 0 }

    mutating func process(rms: Float, startMs: Double, durationMs: Double) -> (speaking: Bool, atMs: Double)? {
        let threshold = max(PracticeVadTuning.absoluteMinThreshold, noiseFloor * PracticeVadTuning.thresholdRatio)
        let above = rms > threshold
        if !speaking {
            let rate = rms < noiseFloor ? PracticeVadTuning.noiseFloorFallRate : PracticeVadTuning.noiseFloorRiseRate
            noiseFloor += (rms - noiseFloor) * rate
            noiseFloor = min(max(noiseFloor, PracticeVadTuning.minNoiseFloor), PracticeVadTuning.maxNoiseFloor)
        }
        if !speaking {
            if above {
                if aboveMs == 0 { runStartMs = startMs }
                aboveMs += durationMs
                if aboveMs >= PracticeVadTuning.startHoldMs {
                    speaking = true; aboveMs = 0; belowMs = 0
                    return (true, runStartMs)
                }
            } else { aboveMs = 0 }
        } else {
            if above { belowMs = 0 }
            else {
                if belowMs == 0 { runStartMs = startMs }
                belowMs += durationMs
                if belowMs >= PracticeVadTuning.endHoldMs {
                    speaking = false; belowMs = 0; aboveMs = 0
                    return (false, runStartMs)
                }
            }
        }
        return nil
    }
}

/// 16 kHz mono 16-bit PCM WAV. Created exclusively (never overwrites, never
/// follows a symlink) with mode 0600. Header sizes are patched on finalize.
final class WavWriter: @unchecked Sendable {
    static let sampleRate = 16_000
    private var fd: Int32
    private(set) var frames: Int64 = 0
    private var finalized = false

    init(path: String) throws {
        let descriptor = Darwin.open(path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard descriptor >= 0 else { throw HelperFailure.code("recording-failed") }
        fd = descriptor
        do { try writeAll(Self.header(dataBytes: 0)) }
        catch { Darwin.close(descriptor); fd = -1; throw error }
    }

    private static func header(dataBytes: UInt32) -> [UInt8] {
        func le32(_ v: UInt32) -> [UInt8] { (0..<4).map { UInt8((v >> (8 * UInt32($0))) & 0xFF) } }
        func le16(_ v: UInt16) -> [UInt8] { [UInt8(v & 0xFF), UInt8(v >> 8)] }
        var h: [UInt8] = Array("RIFF".utf8)
        h += le32(36 &+ dataBytes)
        h += Array("WAVEfmt ".utf8)
        h += le32(16) + le16(1) + le16(1)
        h += le32(UInt32(sampleRate)) + le32(UInt32(sampleRate * 2)) + le16(2) + le16(16)
        h += Array("data".utf8) + le32(dataBytes)
        return h
    }

    private func writeAll(_ bytes: [UInt8]) throws {
        try bytes.withUnsafeBytes { try writeRaw($0.baseAddress, $0.count) }
    }

    private func writeRaw(_ base: UnsafeRawPointer?, _ count: Int) throws {
        guard fd >= 0, let base else { throw HelperFailure.code("recording-failed") }
        var offset = 0
        while offset < count {
            let written = Darwin.write(fd, base + offset, count - offset)
            if written < 0 {
                if errno == EINTR { continue }
                throw HelperFailure.code("recording-failed")
            }
            offset += written
        }
    }

    private func hasRoom(for newFrames: Int) -> Bool {
        (frames + Int64(newFrames)) * 2 <= Int64(UInt32.max - 36)
    }

    func append(_ samples: UnsafePointer<Int16>, count: Int) throws {
        guard count > 0, !finalized else { return }
        guard hasRoom(for: count) else { throw HelperFailure.code("recording-failed") }
        try writeRaw(UnsafeRawPointer(samples), count * 2)
        frames += Int64(count)
    }

    func appendSilence(frames count: Int) throws {
        guard count > 0, !finalized else { return }
        guard hasRoom(for: count) else { throw HelperFailure.code("recording-failed") }
        let chunk = [UInt8](repeating: 0, count: 8192)
        var remaining = count * 2
        while remaining > 0 {
            let n = min(remaining, chunk.count)
            try chunk.withUnsafeBytes { try writeRaw($0.baseAddress, n) }
            remaining -= n
        }
        frames += Int64(count)
    }

    /// Patches the header sizes, fsyncs and closes. Idempotent. Returns duration.
    @discardableResult
    func finalize() -> Int? {
        guard !finalized else { return nil }
        finalized = true
        guard fd >= 0 else { return nil }
        let bytes = UInt32(clamping: frames * 2)
        let header = Self.header(dataBytes: bytes)
        var ok = false
        if Darwin.lseek(fd, 0, SEEK_SET) == 0 {
            ok = header.withUnsafeBytes { raw -> Bool in
                var offset = 0
                while offset < raw.count {
                    let n = Darwin.write(fd, raw.baseAddress! + offset, raw.count - offset)
                    if n < 0 { if errno == EINTR { continue }; return false }
                    offset += n
                }
                return true
            }
        }
        _ = Darwin.fsync(fd)
        Darwin.close(fd); fd = -1
        return ok ? Int(frames * 1000 / Int64(Self.sampleRate)) : nil
    }

    static func validate(path: String) -> Bool {
        guard path.hasPrefix("/"), path.hasSuffix(".wav"), path.utf8.count < 4096,
              !path.contains("\0") else { return false }
        let parent = (path as NSString).deletingLastPathComponent
        var isDirectory: ObjCBool = false
        guard !parent.isEmpty, FileManager.default.fileExists(atPath: parent, isDirectory: &isDirectory),
              isDirectory.boolValue else { return false }
        var info = stat()
        return lstat(path, &info) != 0 && errno == ENOENT
    }
}

enum Command: Sendable {
    case play(id: String, sampleRate: Int)
    case audio(id: String, pcm: Data)
    case end(id: String)
    case cancel(id: String)
    case pause(id: String)
    case resume(id: String)
    case mute(Bool)
    case stop

    static let maxLineBytes = 262_144

    static func validID(_ value: Any?) -> String? {
        guard let id = value as? String, (1...64).contains(id.utf8.count),
              id.utf8.allSatisfy({ ($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x41 && $0 <= 0x5A)
                  || ($0 >= 0x61 && $0 <= 0x7A) || $0 == 0x5F || $0 == 0x2D }) else { return nil }
        return id
    }

    static func parse(_ line: Data) -> Command? {
        guard line.count <= maxLineBytes,
              let object = try? JSONSerialization.jsonObject(with: line) as? [String: Any],
              let type = object["type"] as? String else { return nil }
        switch type {
        case "play":
            guard let id = validID(object["utteranceId"]), let rate = object["sampleRate"] as? Int,
                  rate == 24_000 || rate == 44_100 else { return nil }
            return .play(id: id, sampleRate: rate)
        case "audio":
            guard let id = validID(object["utteranceId"]), let text = object["pcm"] as? String,
                  let data = Data(base64Encoded: text) else { return nil }
            return .audio(id: id, pcm: data)
        case "end":
            guard let id = validID(object["utteranceId"]) else { return nil }
            return .end(id: id)
        case "cancel":
            guard let id = validID(object["utteranceId"]) else { return nil }
            return .cancel(id: id)
        case "pause":
            guard let id = validID(object["utteranceId"]) else { return nil }
            return .pause(id: id)
        case "resume":
            guard let id = validID(object["utteranceId"]) else { return nil }
            return .resume(id: id)
        case "mute":
            guard let muted = object["muted"] as? Bool else { return nil }
            return .mute(muted)
        case "stop": return .stop
        default: return nil
        }
    }
}

/// Bounded line reader: oversized lines are discarded without buffering them.
enum StdinReader {
    /// `onLine` returns false to stop reading.
    static func run(_ onLine: (Data) -> Bool) {
        var pending = Data()
        var discarding = false
        var chunk = [UInt8](repeating: 0, count: 65_536)
        while true {
            let count = chunk.withUnsafeMutableBytes { Darwin.read(0, $0.baseAddress, $0.count) }
            if count < 0 { if errno == EINTR { continue }; return }
            if count == 0 { return }
            for byte in chunk[0..<count] {
                if byte == 0x0A {
                    if !discarding, !pending.isEmpty, !onLine(pending) { return }
                    pending.removeAll(keepingCapacity: true); discarding = false
                } else if !discarding {
                    pending.append(byte)
                    if pending.count > Command.maxLineBytes { pending.removeAll(); discarding = true }
                }
            }
        }
    }
}

/// Shared monotonic timeline (milliseconds since mic capture started). The mic
/// queue advances it by captured sample counts; other threads read an estimate.
final class TimelineClock: @unchecked Sendable {
    private let lock = NSLock()
    private var endSec = 0.0
    private var arrival = ProcessInfo.processInfo.systemUptime
    private var lastReported = 0

    func publish(endSec: Double, arrival: TimeInterval) {
        lock.lock(); self.endSec = endSec; self.arrival = arrival; lock.unlock()
    }

    func nowMs() -> Int {
        lock.lock(); defer { lock.unlock() }
        let elapsed = min(max(ProcessInfo.processInfo.systemUptime - arrival, 0), 0.25)
        lastReported = max(lastReported, Int(((endSec + elapsed) * 1000).rounded()))
        return lastReported
    }
}

/// Mic buffers arrive on the render thread; they are only copied there. All
/// conversion, VAD, analyzer feeding and WAV writing happen on `queue`.
final class MicProcessor: @unchecked Sendable {
    private let queue = DispatchQueue(label: "practice-audio.mic", qos: .userInitiated)
    private let analyzerFormat: AVAudioFormat
    private let input: AsyncStream<AnalyzerInput>.Continuation
    private let writer: ProtocolWriter
    private let wav: WavWriter
    private let clock: TimelineClock
    private let fail: @Sendable (String) -> Void
    private let wavFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16_000,
                                          channels: 1, interleaved: true)!
    // Tap-thread state.
    private let formatLock = NSLock()
    private var monoFormat: AVAudioFormat?
    // Queue-confined state.
    private var analyzerConverter: AVAudioConverter?
    private var wavConverter: AVAudioConverter?
    private var sourceRate = 0.0
    private var timelineSec = 0.0
    private var lastArrival: TimeInterval?
    private var interrupted = false
    private var muted = false
    private var analyzerNeedsStart = true
    private var vad = EnergyVad()
    private var levelSumSquares = 0.0
    private var levelCount = 0
    private var timer: DispatchSourceTimer?
    private var stopped = false

    init(analyzerFormat: AVAudioFormat, input: AsyncStream<AnalyzerInput>.Continuation,
         writer: ProtocolWriter, wav: WavWriter, clock: TimelineClock,
         fail: @escaping @Sendable (String) -> Void) {
        self.analyzerFormat = analyzerFormat; self.input = input; self.writer = writer
        self.wav = wav; self.clock = clock; self.fail = fail
    }

    func startLevelTimer() {
        queue.async {
            guard !self.stopped, self.timer == nil else { return }
            let timer = DispatchSource.makeTimerSource(queue: self.queue)
            timer.schedule(deadline: .now() + .milliseconds(100), repeating: .milliseconds(100))
            // Retained until stop() cancels the timer.
            timer.setEventHandler { self.emitLevel() }
            self.timer = timer
            timer.resume()
        }
    }

    func stop() async {
        await withCheckedContinuation { continuation in
            queue.async {
                self.stopped = true
                self.timer?.cancel(); self.timer = nil
                self.analyzerConverter = nil; self.wavConverter = nil
                self.input.finish()
                continuation.resume()
            }
        }
    }

    func setMuted(_ value: Bool) {
        queue.async {
            guard !self.stopped, self.muted != value else { return }
            self.muted = value
            if value {
                if self.vad.speaking { self.emitVad(false, atSec: self.timelineSec) }
                self.vad.reset()
                self.levelSumSquares = 0; self.levelCount = 0
            } else {
                self.analyzerNeedsStart = true
                self.analyzerConverter = nil; self.wavConverter = nil; self.sourceRate = 0
            }
        }
    }

    /// The engine was reconfigured; the next buffer adds the gap as silence.
    func markInterruption() {
        queue.async { self.interrupted = true }
    }

    /// Render-thread entry: copy channel 0 only, then hop to the serial queue.
    func ingest(_ buffer: AVAudioPCMBuffer) {
        let frames = Int(buffer.frameLength)
        guard frames > 0, let channel = buffer.floatChannelData?[0] else { return }
        let rate = buffer.format.sampleRate
        formatLock.lock()
        if monoFormat?.sampleRate != rate {
            monoFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: rate, channels: 1, interleaved: false)
        }
        let format = monoFormat
        formatLock.unlock()
        guard let format, let mono = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames)),
              let destination = mono.floatChannelData?[0] else { return }
        destination.update(from: channel, count: frames)
        mono.frameLength = AVAudioFrameCount(frames)
        let arrival = ProcessInfo.processInfo.systemUptime
        queue.async { self.process(mono, arrival: arrival) }
    }

    private func emitLevel() {
        guard !stopped else { return }
        var rms = 0.0
        if !muted, levelCount > 0 { rms = min(1, (levelSumSquares / Double(levelCount)).squareRoot()) }
        levelSumSquares = 0; levelCount = 0
        writer.send(["type": "level", "rms": (rms * 1000).rounded() / 1000,
                     "atMs": Int((timelineSec * 1000).rounded())])
    }

    private func emitVad(_ speaking: Bool, atSec: Double) {
        writer.send(["type": "vad", "speaking": speaking, "atMs": max(0, Int((atSec * 1000).rounded()))])
    }

    private func convert(_ source: AVAudioPCMBuffer, with converter: AVAudioConverter,
                         to format: AVAudioFormat) -> AVAudioPCMBuffer? {
        let capacity = AVAudioFrameCount(ceil(Double(source.frameLength) * format.sampleRate / source.format.sampleRate) + 64)
        guard let converted = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else { return nil }
        var supplied = false
        var conversionError: NSError?
        let status = converter.convert(to: converted, error: &conversionError) { _, outStatus in
            if supplied { outStatus.pointee = .noDataNow; return nil }
            supplied = true; outStatus.pointee = .haveData; return source
        }
        guard conversionError == nil, status != .error else { return nil }
        return converted
    }

    /// Keeps the WAV exactly on the timeline: pads or trims to the target length.
    private func alignWav(to targetSec: Double, samples: AVAudioPCMBuffer?) {
        let target = Int64((targetSec * Double(WavWriter.sampleRate)).rounded())
        var needed = Int(max(0, target - wav.frames))
        do {
            if let samples, let data = samples.int16ChannelData?[0], needed > 0 {
                let count = min(Int(samples.frameLength), needed)
                try wav.append(data, count: count)
                needed -= count
            }
            try wav.appendSilence(frames: needed)
        } catch { fail("recording-failed") }
    }

    private func process(_ mono: AVAudioPCMBuffer, arrival: TimeInterval) {
        guard !stopped else { return }
        let rate = mono.format.sampleRate
        let frames = Int(mono.frameLength)
        guard rate > 0, frames > 0 else { return }
        let duration = Double(frames) / rate
        if interrupted {
            interrupted = false
            if let last = lastArrival {
                let gap = min(max(0, (arrival - duration) - last), 120)
                if vad.speaking { emitVad(false, atSec: timelineSec) }
                vad.reset()
                timelineSec += gap
                alignWav(to: timelineSec, samples: nil)
            }
            analyzerNeedsStart = true
            analyzerConverter = nil; wavConverter = nil; sourceRate = 0
        }
        lastArrival = arrival
        if rate != sourceRate || analyzerConverter == nil || wavConverter == nil {
            sourceRate = rate
            analyzerConverter = AVAudioConverter(from: mono.format, to: analyzerFormat)
            wavConverter = AVAudioConverter(from: mono.format, to: wavFormat)
            analyzerConverter?.primeMethod = .none
            wavConverter?.primeMethod = .none
        }
        let startSec = timelineSec
        timelineSec += duration
        if muted {
            alignWav(to: timelineSec, samples: nil)
            clock.publish(endSec: timelineSec, arrival: arrival)
            return
        }
        // Level and VAD in ~10 ms windows.
        if let samples = mono.floatChannelData?[0] {
            let windowFrames = max(1, Int(rate * PracticeVadTuning.windowMs / 1000))
            var index = 0
            while index < frames {
                let count = min(windowFrames, frames - index)
                var sum: Float = 0
                for i in index..<(index + count) { sum += samples[i] * samples[i] }
                levelSumSquares += Double(sum); levelCount += count
                let windowRms = (sum / Float(count)).squareRoot()
                let windowStartMs = (startSec + Double(index) / rate) * 1000
                if let change = vad.process(rms: windowRms, startMs: windowStartMs,
                                            durationMs: Double(count) / rate * 1000) {
                    emitVad(change.speaking, atSec: change.atMs / 1000)
                }
                index += count
            }
        }
        guard let analyzerConverter, let wavConverter else { fail("capture-failed"); return }
        guard let forAnalyzer = convert(mono, with: analyzerConverter, to: analyzerFormat),
              let forWav = convert(mono, with: wavConverter, to: wavFormat) else {
            fail("capture-failed"); return
        }
        if forAnalyzer.frameLength > 0 {
            let item: AnalyzerInput
            if analyzerNeedsStart {
                analyzerNeedsStart = false
                item = AnalyzerInput(buffer: forAnalyzer, bufferStartTime:
                    CMTime(value: Int64((startSec * 1_000_000).rounded()), timescale: 1_000_000))
            } else {
                item = AnalyzerInput(buffer: forAnalyzer)
            }
            if case .dropped = input.yield(item) { fail("recognition-failed") } // Never silently lose speech.
        }
        alignWav(to: timelineSec, samples: forWav)
        clock.publish(endSec: timelineSec, arrival: arrival)
    }
}

/// Plays utterances on a player node attached to the SHARED engine's main
/// mixer, so voice processing sees the playback as its echo reference.
@MainActor final class PlaybackController {
    private struct Utterance {
        let id: String
        let rate: Double
        let generation: Int
        var scheduledFrames: Int64 = 0
        var pending = 0
        var ended = false
        var started = false
        var offsetSec = 0.0
        var carry: UInt8?
        var lastPositionAt: TimeInterval = 0
        var paused = false
        var pausedPositionMs = 0
    }

    private let engine: AVAudioEngine
    private let player = AVAudioPlayerNode()
    private let writer: ProtocolWriter
    private let clock: TimelineClock
    private let fail: (String) -> Void
    private var active: Utterance?
    private var generation = 0
    private var connectedRate = 0.0
    private var timer: DispatchSourceTimer?
    private static let maxSecondsPerUtterance = 600.0

    init(engine: AVAudioEngine, writer: ProtocolWriter, clock: TimelineClock, fail: @escaping (String) -> Void) {
        self.engine = engine; self.writer = writer; self.clock = clock; self.fail = fail
    }

    /// Attach and connect before the engine starts (voice processing already on).
    func attach() {
        engine.attach(player)
        connect(rate: 24_000)
    }

    /// Re-establish the connection after an engine restart.
    func reconnect() {
        player.stop()
        connect(rate: connectedRate > 0 ? connectedRate : 24_000)
    }

    private func connect(rate: Double) {
        guard let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: rate, channels: 1, interleaved: false) else { return }
        engine.disconnectNodeOutput(player)
        engine.connect(player, to: engine.mainMixerNode, format: format)
        connectedRate = rate
    }

    func startTimer() {
        guard timer == nil else { return }
        let timer = DispatchSource.makeTimerSource(queue: .main)
        timer.schedule(deadline: .now(), repeating: .milliseconds(10), leeway: .milliseconds(2))
        timer.setEventHandler { [weak self] in Task { @MainActor in self?.tick() } }
        self.timer = timer
        timer.resume()
    }

    func play(id: String, sampleRate: Int) {
        cancelActive()
        let rate = Double(sampleRate)
        guard engine.isRunning else { fail("playback-failed"); return }
        player.stop() // The player's sample clock restarts at 0 on stop/play.
        if connectedRate != rate { connect(rate: rate) }
        generation += 1
        active = Utterance(id: id, rate: rate, generation: generation)
    }

    func audio(id: String, pcm: Data) {
        guard var utterance = active, utterance.id == id, !utterance.ended else { return }
        var bytes = [UInt8]()
        bytes.reserveCapacity(pcm.count + 1)
        if let carry = utterance.carry { bytes.append(carry); utterance.carry = nil }
        bytes.append(contentsOf: pcm)
        if bytes.count % 2 == 1 { utterance.carry = bytes.removeLast() }
        let frames = bytes.count / 2
        guard frames > 0 else { active = utterance; return }
        guard Double(utterance.scheduledFrames + Int64(frames)) / utterance.rate <= Self.maxSecondsPerUtterance,
              let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: utterance.rate, channels: 1, interleaved: false),
              let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames)),
              let channel = buffer.floatChannelData?[0] else { active = utterance; return }
        for index in 0..<frames {
            let sample = Int16(bitPattern: UInt16(bytes[index * 2]) | (UInt16(bytes[index * 2 + 1]) << 8))
            channel[index] = Float(sample) / 32768
        }
        buffer.frameLength = AVAudioFrameCount(frames)
        // If the player ran dry, its clock kept counting silence: exclude it.
        if utterance.started, !utterance.paused, let now = renderSeconds() {
            let scheduledSec = Double(utterance.scheduledFrames) / utterance.rate
            if now - utterance.offsetSec > scheduledSec { utterance.offsetSec = now - scheduledSec }
        }
        utterance.scheduledFrames += Int64(frames)
        utterance.pending += 1
        let token = utterance.generation
        active = utterance
        player.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { [weak self] _ in
            Task { @MainActor in self?.bufferPlayed(token) }
        }
        // While paused, newly scheduled buffers wait silently for `resume`.
        if !player.isPlaying, !utterance.paused {
            guard engine.isRunning else { fail("playback-failed"); return }
            player.play()
        }
    }

    func end(id: String) {
        guard var utterance = active, utterance.id == id else { return }
        utterance.ended = true
        active = utterance
        if utterance.pending == 0 { finishActive() }
    }

    func cancel(id: String) {
        guard let utterance = active, utterance.id == id else { return }
        cancelActive()
    }

    /// Silence the active utterance immediately; scheduled buffers and the
    /// player's sample clock are kept, so `resume` continues at the same sample.
    func pause(id: String) {
        guard var utterance = active, utterance.id == id, !utterance.paused else { return }
        let position = positionMs(utterance)
        utterance.paused = true
        utterance.pausedPositionMs = position
        active = utterance
        player.pause()
        emit(utterance.id, "paused", position)
    }

    /// Continue from the paused sample. The clock did not advance while paused,
    /// so no dry-run offset correction is needed here.
    func resume(id: String) {
        guard var utterance = active, utterance.id == id, utterance.paused else { return }
        guard engine.isRunning else { fail("playback-failed"); return }
        let position = utterance.pausedPositionMs
        utterance.paused = false
        utterance.lastPositionAt = ProcessInfo.processInfo.systemUptime
        active = utterance
        player.play()
        emit(utterance.id, "resumed", position)
    }

    /// Stops audio immediately (within one render cycle) and reports the played position.
    func cancelActive() {
        guard let utterance = active else { return }
        let position = positionMs(utterance)
        active = nil
        player.stop()
        player.reset()
        emit(utterance.id, "cancelled", position)
    }

    func shutdown() {
        timer?.cancel(); timer = nil
        cancelActive()
        player.stop()
    }

    private func bufferPlayed(_ token: Int) {
        guard var utterance = active, utterance.generation == token else { return }
        utterance.pending = max(0, utterance.pending - 1)
        active = utterance
        if utterance.pending == 0, utterance.ended { finishActive() }
    }

    private func finishActive() {
        guard let utterance = active else { return }
        active = nil
        let total = Int((Double(utterance.scheduledFrames) / utterance.rate * 1000).rounded())
        player.stop()
        emit(utterance.id, "finished", total)
    }

    private func renderSeconds() -> Double? {
        guard player.isPlaying, let nodeTime = player.lastRenderTime,
              let playerTime = player.playerTime(forNodeTime: nodeTime),
              playerTime.isSampleTimeValid, playerTime.sampleRate > 0 else { return nil }
        return Double(playerTime.sampleTime) / playerTime.sampleRate
    }

    private func positionMs(_ utterance: Utterance) -> Int {
        // Paused: the player's clock is frozen, so report the recorded position.
        if utterance.paused { return utterance.pausedPositionMs }
        guard utterance.started || utterance.scheduledFrames > 0, let now = renderSeconds() else { return 0 }
        let total = Double(utterance.scheduledFrames) / utterance.rate
        let seconds = min(max(now - utterance.offsetSec, 0), total)
        return Int((seconds * 1000).rounded())
    }

    private func emit(_ id: String, _ state: String, _ positionMs: Int) {
        writer.send(["type": "playback", "utteranceId": id, "state": state,
                     "positionMs": positionMs, "atMs": clock.nowMs()])
    }

    private func tick() {
        // No position events while paused; positionMs stays at the paused value.
        guard var utterance = active, !utterance.paused, let now = renderSeconds(), now > 0 else { return }
        let uptime = ProcessInfo.processInfo.systemUptime
        if !utterance.started {
            utterance.started = true; utterance.lastPositionAt = uptime
            active = utterance
            emit(utterance.id, "started", positionMs(utterance))
        } else if uptime - utterance.lastPositionAt >= 0.05 {
            utterance.lastPositionAt = uptime
            active = utterance
            emit(utterance.id, "position", positionMs(utterance))
        }
    }
}

@available(macOS 26.0, *)
@MainActor final class PracticeSession {
    private let parentPID: pid_t
    private let locale: Locale
    private let writer: ProtocolWriter
    private let wav: WavWriter
    private let finish: AsyncStream<String>.Continuation
    private let engine = AVAudioEngine()
    private let clock = TimelineClock()
    private var playback: PlaybackController?
    private var mic: MicProcessor?
    private var analyzer: SpeechAnalyzer?
    private var resultsTask: Task<Void, Never>?
    private var parentTimer: DispatchSourceTimer?
    private var configObserver: NSObjectProtocol?
    private var stopped = false
    private var muted = false
    private var lastRestartAt: TimeInterval?

    init(parentPID: pid_t, locale: Locale, writer: ProtocolWriter, wav: WavWriter,
         finish: AsyncStream<String>.Continuation) {
        self.parentPID = parentPID; self.locale = locale; self.writer = writer
        self.wav = wav; self.finish = finish
    }

    func handle(_ command: Command) {
        guard !stopped else { return }
        switch command {
        case .play(let id, let rate): playback?.play(id: id, sampleRate: rate)
        case .audio(let id, let pcm): playback?.audio(id: id, pcm: pcm)
        case .end(let id): playback?.end(id: id)
        case .cancel(let id): playback?.cancel(id: id)
        case .pause(let id): playback?.pause(id: id)
        case .resume(let id): playback?.resume(id: id)
        case .mute(let value): muted = value; mic?.setMuted(value)
        case .stop: finish.yield("stopped")
        }
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
            // Only language-model assets may be downloaded.
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

            // Microphone permission strictly before the engine starts.
            let granted = await withCheckedContinuation { (continuation: CheckedContinuation<Bool, Never>) in
                AVCaptureDevice.requestAccess(for: .audio) { continuation.resume(returning: $0) }
            }
            guard granted else { throw HelperFailure.code("permission-denied") }
            try Task.checkCancellation()
            guard !stopped else { return }

            // Voice processing (echo cancellation) must be on before anything
            // is attached or started. Never continue without it.
            do { try engine.inputNode.setVoiceProcessingEnabled(true) }
            catch { throw HelperFailure.code("capture-failed") }

            let (inputs, continuation) = AsyncStream<AnalyzerInput>.makeStream(bufferingPolicy: .bufferingNewest(100))
            let micProcessor = MicProcessor(analyzerFormat: format, input: continuation, writer: writer,
                                            wav: wav, clock: clock) { [weak self] code in
                Task { @MainActor in self?.fail(code) }
            }
            mic = micProcessor
            let playbackController = PlaybackController(engine: engine, writer: writer, clock: clock) { [weak self] code in
                self?.fail(code)
            }
            playback = playbackController
            resultsTask = Task { [weak self] in
                do {
                    for try await result in transcriber.results {
                        guard let self, !self.stopped, !Task.isCancelled else { return }
                        guard !self.muted else { continue }
                        let text = String(result.text.characters).trimmingCharacters(in: .whitespacesAndNewlines)
                        guard !text.isEmpty else { continue }
                        guard text.count <= 4000 else { self.fail("recognition-failed"); return }
                        let start = result.range.start.seconds
                        let end = CMTimeRangeGetEnd(result.range).seconds
                        guard start.isFinite, end.isFinite, start >= 0, end >= start,
                              end < Double(Int.max / 1000) else { self.fail("recognition-failed"); return }
                        let startMs = Int((start * 1000).rounded())
                        let endMs = Int((end * 1000).rounded())
                        self.writer.send(["type": "transcript", "text": text, "segmentId": String(startMs),
                            "final": result.isFinal, "startMs": startMs, "endMs": endMs])
                    }
                } catch { if !Task.isCancelled { self?.fail("recognition-failed") } }
            }
            try await analyzer.start(inputSequence: inputs)
            try Task.checkCancellation()
            guard !stopped else { return }

            playbackController.attach()
            installTap()
            engine.prepare()
            do { try engine.start() } catch { throw HelperFailure.code("capture-failed") }
            configObserver = NotificationCenter.default.addObserver(
                forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main) { [weak self] _ in
                Task { @MainActor in self?.engineConfigurationChanged() }
            }
            micProcessor.startLevelTimer()
            playbackController.startTimer()
            let timer = DispatchSource.makeTimerSource(queue: .main)
            timer.schedule(deadline: .now() + .seconds(1), repeating: .seconds(1))
            timer.setEventHandler { [weak self] in
                Task { @MainActor in
                    guard let self else { return }
                    if Darwin.kill(self.parentPID, 0) != 0 && errno != EPERM { self.finish.yield("parent-exited") }
                }
            }
            parentTimer = timer; timer.resume()
            writer.send(["type": "status", "state": "ready"])
        } catch is CancellationError {
            finish.yield("stopped")
        } catch let failure as HelperFailure { fail(failure.code) }
        catch { fail("capture-failed") }
    }

    private func installTap() {
        guard let mic else { return }
        // format: nil taps the input node at its native (voice-processed) output
        // format; the processor reads each buffer's own format and channel 0.
        engine.inputNode.installTap(onBus: 0, bufferSize: 2048, format: nil) { buffer, _ in
            mic.ingest(buffer)
        }
    }

    /// One restart with the same graph; a second change within 10 s fails.
    private func engineConfigurationChanged() {
        guard !stopped, !engine.isRunning else { return }
        let now = ProcessInfo.processInfo.systemUptime
        if let last = lastRestartAt, now - last < 10 { fail("capture-failed"); return }
        lastRestartAt = now
        mic?.markInterruption()
        playback?.cancelActive() // The queued buffers do not survive a reconfiguration.
        engine.inputNode.removeTap(onBus: 0)
        playback?.reconnect()
        installTap()
        engine.prepare()
        do { try engine.start() } catch { fail("capture-failed") }
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
        if let configObserver { NotificationCenter.default.removeObserver(configObserver) }
        configObserver = nil
        playback?.shutdown()
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        await mic?.stop(); mic = nil
        resultsTask?.cancel(); resultsTask = nil
        await analyzer?.cancelAndFinishNow(); analyzer = nil
        if let durationMs = wav.finalize() {
            writer.send(["type": "recording", "state": "closed", "durationMs": durationMs])
        } else {
            writer.send(["type": "error", "code": "recording-failed"])
        }
    }
}

@main enum PracticeAudioHelper {
    static func main() async {
        let writer = ProtocolWriter()
        let arguments = Array(CommandLine.arguments.dropFirst())
        guard arguments.count == 6, arguments[0] == "--parent-pid", arguments[2] == "--locale",
              arguments[4] == "--recording",
              let pid = Int32(arguments[1]), pid > 1, pid == getppid(), arguments[3] == "en-US" else {
            writer.send(["type": "error", "code": "capture-failed"]); return
        }
        guard WavWriter.validate(path: arguments[5]) else {
            writer.send(["type": "error", "code": "recording-failed"]); return
        }
        guard #available(macOS 26.0, *) else {
            writer.send(["type": "error", "code": "unsupported-platform"]); return
        }
        let wav: WavWriter
        do { wav = try WavWriter(path: arguments[5]) }
        catch { writer.send(["type": "error", "code": "recording-failed"]); return }
        signal(SIGPIPE, SIG_IGN)
        signal(SIGTERM, SIG_IGN)
        signal(SIGINT, SIG_IGN)
        let (terminations, finish) = AsyncStream<String>.makeStream(bufferingPolicy: .bufferingNewest(1))
        let term = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .global())
        let interrupt = DispatchSource.makeSignalSource(signal: SIGINT, queue: .global())
        term.setEventHandler { finish.yield("stopped") }; term.resume()
        interrupt.setEventHandler { finish.yield("stopped") }; interrupt.resume()
        // Commands are bounded by a semaphore: the reader stalls (pipe
        // back-pressure) instead of buffering without limit.
        let (commands, commandInput) = AsyncStream<Command>.makeStream(bufferingPolicy: .unbounded)
        let slots = DispatchSemaphore(value: 256)
        // EOF also handles owner crashes without depending on PID reuse.
        DispatchQueue.global(qos: .utility).async {
            StdinReader.run { line in
                guard let command = Command.parse(line) else { return true }
                if case .stop = command { return false }
                slots.wait()
                commandInput.yield(command)
                return true
            }
            finish.yield("stopped")
        }
        let session = PracticeSession(parentPID: pid, locale: Locale(identifier: "en-US"),
                                      writer: writer, wav: wav, finish: finish)
        let dispatcher = Task {
            for await command in commands { session.handle(command); slots.signal() }
        }
        let startup = Task { await session.start() }
        for await _ in terminations { break }
        startup.cancel(); dispatcher.cancel()
        await session.stop()
        commandInput.finish(); finish.finish(); term.cancel(); interrupt.cancel()
    }
}
