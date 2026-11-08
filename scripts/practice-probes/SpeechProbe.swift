// SpeechProbe.swift — Phase 0 probe: does Apple's on-device SpeechTranscriber keep um/uh?
//
// Build:  swiftc -parse-as-library -O -target arm64-apple-macos26 -o <out> SpeechProbe.swift
//   (see build-speech-probe.sh)
// Use:
//   SpeechProbe record --seconds N --out file.caf
//   SpeechProbe transcribe --in file.caf --out words.json
//
// SDK findings (Speech.swiftinterface, macOS 26 SDK):
//  * SpeechTranscriber.TranscriptionOption has ONLY `etiquetteReplacements`
//    (it masks profanity; unrelated to disfluencies). There is NO disfluency /
//    filler-preserving option on SpeechTranscriber. (DictationTranscriber also
//    has `emoji`; neither has a disfluency option.) So transcriptionOptions = [].
//  * File input exists: SpeechAnalyzer.analyzeSequence(from: AVAudioFile) and
//    start(inputAudioFile:finishAfterFile:). We use analyzeSequence(from:).
//  * ResultAttributeOption: .audioTimeRange, .transcriptionConfidence.
//  * ReportingOption: .volatileResults, .alternativeTranscriptions, .fastResults.
//    We pass [] (final results only).

import Foundation
import AVFoundation
import Speech
import CoreMedia

struct ProbeError: Error, CustomStringConvertible {
    let description: String
    init(_ message: String) { description = message }
}

func stderrPrint(_ message: String) {
    FileHandle.standardError.write(Data((message + "\n").utf8))
}

func argValue(_ name: String, in args: [String]) -> String? {
    guard let index = args.firstIndex(of: name), index + 1 < args.count else { return nil }
    return args[index + 1]
}

// MARK: record

final class Recorder: @unchecked Sendable {
    private let engine = AVAudioEngine()
    private var file: AVAudioFile?
    private let lock = NSLock()
    private var failure: Error?

    func run(seconds: Int, outURL: URL) async throws {
        let granted = await withCheckedContinuation { (cont: CheckedContinuation<Bool, Never>) in
            AVCaptureDevice.requestAccess(for: .audio) { cont.resume(returning: $0) }
        }
        guard granted else {
            throw ProbeError("microphone permission denied (grant it to your terminal app in System Settings > Privacy & Security > Microphone)")
        }
        guard let target = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16_000, channels: 1, interleaved: true) else {
            throw ProbeError("cannot build 16 kHz mono format")
        }
        let input = engine.inputNode
        let inFormat = input.outputFormat(forBus: 0)
        guard inFormat.sampleRate > 0, let converter = AVAudioConverter(from: inFormat, to: target) else {
            throw ProbeError("no usable microphone input format")
        }
        try? FileManager.default.removeItem(at: outURL)
        let outFile = try AVAudioFile(forWriting: outURL, settings: target.settings,
                                      commonFormat: .pcmFormatInt16, interleaved: true)
        file = outFile
        input.installTap(onBus: 0, bufferSize: 4096, format: inFormat) { [weak self] buffer, _ in
            guard let self else { return }
            let ratio = target.sampleRate / inFormat.sampleRate
            let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 64
            guard let converted = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else { return }
            var supplied = false
            var error: NSError?
            let status = converter.convert(to: converted, error: &error) { _, outStatus in
                if supplied { outStatus.pointee = .noDataNow; return nil }
                supplied = true; outStatus.pointee = .haveData; return buffer
            }
            if status == .error || error != nil {
                self.lock.lock(); self.failure = error ?? ProbeError("conversion failed"); self.lock.unlock()
                return
            }
            guard converted.frameLength > 0 else { return }
            do { try outFile.write(from: converted) } catch {
                self.lock.lock(); self.failure = error; self.lock.unlock()
            }
        }
        engine.prepare()
        try engine.start()
        stderrPrint("Recording \(seconds)s to \(outURL.path). Start reading now.")
        var remaining = seconds
        while remaining > 0 {
            stderrPrint("  \(remaining)s left")
            try await Task.sleep(nanoseconds: 1_000_000_000)
            remaining -= 1
        }
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        file = nil
        let err = lock.withLock { failure }
        if let err { throw err }
        stderrPrint("Done.")
    }
}

// MARK: transcribe

struct Segment { let text: String; let startMs: Int; let endMs: Int }

func ms(_ seconds: Double) -> Int { Int((seconds * 1000).rounded()) }

func transcribe(inURL: URL, outURL: URL) async throws {
    let locale = Locale(identifier: "en-US")
    guard SpeechTranscriber.isAvailable,
          let supported = await SpeechTranscriber.supportedLocale(equivalentTo: locale) else {
        throw ProbeError("SpeechTranscriber unavailable or en-US unsupported")
    }
    // transcriptionOptions: [] — no disfluency option exists in this SDK (see header).
    // reportingOptions: [] — final results only. attributeOptions: per-run time ranges.
    let transcriber = SpeechTranscriber(locale: supported, transcriptionOptions: [],
                                        reportingOptions: [], attributeOptions: [.audioTimeRange])
    if await AssetInventory.status(forModules: [transcriber]) != .installed {
        if let install = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
            stderrPrint("Downloading speech assets...")
            try await install.downloadAndInstall()
        }
        guard await AssetInventory.status(forModules: [transcriber]) == .installed else {
            throw ProbeError("speech assets not installed")
        }
    }

    let collector = Task { () -> ([Segment], [Segment]) in
        var segments: [Segment] = []
        var words: [Segment] = []
        for try await result in transcriber.results where result.isFinal {
            let text = String(result.text.characters).trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty else { continue }
            let start = result.range.start.seconds
            let end = CMTimeRangeGetEnd(result.range).seconds
            segments.append(Segment(text: text, startMs: ms(start), endMs: ms(end)))
            for run in result.text.runs {
                let piece = String(result.text[run.range].characters).trimmingCharacters(in: .whitespacesAndNewlines)
                guard !piece.isEmpty, let range = run.audioTimeRange else { continue }
                words.append(Segment(text: piece, startMs: ms(range.start.seconds),
                                     endMs: ms(CMTimeRangeGetEnd(range).seconds)))
            }
        }
        return (segments, words)
    }

    let audioFile = try AVAudioFile(forReading: inURL)
    let analyzer = SpeechAnalyzer(modules: [transcriber])
    do {
        let last = try await analyzer.analyzeSequence(from: audioFile)
        if let last {
            try await analyzer.finalizeAndFinish(through: last)
        } else {
            await analyzer.cancelAndFinishNow()
        }
    } catch {
        collector.cancel()
        throw error
    }
    let (segments, words) = try await collector.value

    func encode(_ items: [Segment]) -> [[String: Any]] {
        items.map { ["text": $0.text, "startMs": $0.startMs, "endMs": $0.endMs] }
    }
    var json: [String: Any] = [
        "engine": "apple-speechtranscriber",
        "locale": supported.identifier,
        "options": ["reporting:final-only", "attribute:audioTimeRange", "transcription:none"],
        "segments": encode(segments),
    ]
    if !words.isEmpty { json["words"] = encode(words) }
    let data = try JSONSerialization.data(withJSONObject: json, options: [.prettyPrinted, .sortedKeys])
    try data.write(to: outURL)
    stderrPrint("Wrote \(segments.count) segments, \(words.count) word runs to \(outURL.path)")
}

// MARK: main

@main
struct SpeechProbe {
    static func main() async {
        let args = Array(CommandLine.arguments.dropFirst())
        do {
            guard let command = args.first else { throw ProbeError(usage) }
            switch command {
            case "record":
                guard let secondsText = argValue("--seconds", in: args), let seconds = Int(secondsText), seconds > 0,
                      let out = argValue("--out", in: args) else { throw ProbeError(usage) }
                try await Recorder().run(seconds: seconds, outURL: URL(fileURLWithPath: out))
            case "transcribe":
                guard let input = argValue("--in", in: args), let out = argValue("--out", in: args) else {
                    throw ProbeError(usage)
                }
                try await transcribe(inURL: URL(fileURLWithPath: input), outURL: URL(fileURLWithPath: out))
            default:
                throw ProbeError(usage)
            }
        } catch {
            stderrPrint("error: \(error)")
            exit(1)
        }
    }

    static let usage = """
    usage:
      SpeechProbe record --seconds N --out file.caf
      SpeechProbe transcribe --in file.caf --out words.json
    """
}
