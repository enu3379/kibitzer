import AppKit
import Darwin
import Foundation

enum KibitzerMode: String {
    case dead
    case idle
    case active
    case unknown

    var color: NSColor {
        switch self {
        case .dead:
            return NSColor.systemRed
        case .idle:
            return NSColor.systemGray
        case .active:
            return NSColor.systemGreen
        case .unknown:
            return NSColor.systemYellow
        }
    }

    var label: String {
        switch self {
        case .dead:
            return "not running"
        case .idle:
            return "idle"
        case .active:
            return "active"
        case .unknown:
            return "unknown"
        }
    }

    var message: String {
        switch self {
        case .dead:
            return "서버가 실행되지 않았습니다. 메뉴에서 'Start server'를 눌러 실행해 주세요."
        case .idle:
            return "서버는 실행 중이며 대기 상태입니다. 활동이 감지되면 자동으로 활성화됩니다."
        case .active:
            return "서버가 작동 중이며 활동을 관찰하고 있습니다."
        case .unknown:
            return "서버 상태를 확인할 수 없습니다. 잠시 후 다시 확인해 주세요."
        }
    }
}

final class KibitzerMenuBarApp: NSObject, NSApplicationDelegate {
    private let rootURL: URL
    private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    private let menu = NSMenu()
    private let statusMenuItem = NSMenuItem(title: "Kibitzer: starting", action: nil, keyEquivalent: "")
    private let startServerMenuItem = NSMenuItem(title: "Start server", action: #selector(startServerClicked), keyEquivalent: "s")
    private let refreshMenuItem = NSMenuItem(title: "Refresh status", action: #selector(refreshClicked), keyEquivalent: "r")
    private let openLogsMenuItem = NSMenuItem(title: "Open logs", action: #selector(openLogsClicked), keyEquivalent: "l")
    private var baseIconImage: NSImage?
    private var baseIconLookupFailed = false
    private var timer: Timer?
    private var attemptedAutostart = false

    init(rootURL: URL) {
        self.rootURL = rootURL
        super.init()
        configureMenu()
        updateStatus(autostartIfDead: true)
        timer = Timer.scheduledTimer(withTimeInterval: 10, repeats: true) { [weak self] _ in
            self?.updateStatus(autostartIfDead: false)
        }
    }

    private func configureMenu() {
        statusMenuItem.isEnabled = false
        menu.addItem(statusMenuItem)
        menu.addItem(NSMenuItem.separator())
        for item in [refreshMenuItem, startServerMenuItem, openLogsMenuItem] {
            item.target = self
            menu.addItem(item)
        }
        menu.addItem(NSMenuItem.separator())
        let quitItem = NSMenuItem(title: "Quit Kibitzer Menu Bar", action: #selector(quitClicked), keyEquivalent: "q")
        quitItem.target = self
        menu.addItem(quitItem)
        statusItem.button?.imagePosition = .imageLeft
        statusItem.button?.imageScaling = .scaleProportionallyDown
        statusItem.button?.setAccessibilityLabel("Kibitzer")
        statusItem.menu = menu
        render(mode: .unknown)
    }

    private func updateStatus(autostartIfDead: Bool) {
        fetchMode { [weak self] mode in
            guard let self else { return }
            self.render(mode: mode)
            if autostartIfDead && mode == .dead && !self.attemptedAutostart {
                self.attemptedAutostart = true
                self.startServer()
            }
        }
    }

    private func fetchMode(completion: @escaping (KibitzerMode) -> Void) {
        let finish: (KibitzerMode) -> Void = { mode in
            DispatchQueue.main.async {
                completion(mode)
            }
        }
        guard let baseURL = effectiveBaseURL() else {
            finish(.dead)
            return
        }

        var identityRequest = URLRequest(url: baseURL.appendingPathComponent("identity"))
        identityRequest.timeoutInterval = 2
        URLSession.shared.dataTask(with: identityRequest) { data, _, error in
            guard error == nil, let data else {
                finish(.dead)
                return
            }
            let identity = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            guard identity?["service"] as? String == "kibitzer",
                  identity?["protocol_version"] as? Int == 1,
                  let instanceID = identity?["instance_id"] as? String,
                  !instanceID.isEmpty else {
                finish(.dead)
                return
            }

            var healthRequest = URLRequest(url: baseURL.appendingPathComponent("health"))
            healthRequest.timeoutInterval = 2
            URLSession.shared.dataTask(with: healthRequest) { healthData, _, healthError in
                guard healthError == nil, let healthData else {
                    finish(.dead)
                    return
                }
                let health = try? JSONSerialization.jsonObject(with: healthData) as? [String: Any]
                let rawMode = health?["mode"] as? String
                finish(KibitzerMode(rawValue: rawMode ?? "") ?? .unknown)
            }.resume()
        }.resume()
    }

    private func effectiveBaseURL() -> URL? {
        let portFile = rootURL.appendingPathComponent("data/kibitzer.port")
        guard let rawPort = try? String(contentsOf: portFile, encoding: .utf8),
              let port = Int(rawPort.trimmingCharacters(in: .whitespacesAndNewlines)),
              (1...65535).contains(port) else {
            return nil
        }
        return URL(string: "http://127.0.0.1:\(port)")
    }

    private func render(mode: KibitzerMode) {
        statusMenuItem.title = mode.message
        startServerMenuItem.isEnabled = mode == .dead
        statusItem.button?.toolTip = "Kibitzer: \(mode.label)"
        statusItem.button?.setAccessibilityLabel("Kibitzer: \(mode.label)")
        statusItem.length = NSStatusItem.variableLength
        if let image = loadBaseIcon() {
            statusItem.button?.image = image
            statusItem.button?.attributedTitle = renderStatusDot(mode: mode)
        } else {
            statusItem.button?.image = nil
            statusItem.button?.attributedTitle = renderStatusTitle(mode: mode)
        }
    }

    private func loadBaseIcon() -> NSImage? {
        if let baseIconImage = baseIconImage {
            return baseIconImage
        }
        if baseIconLookupFailed {
            return nil
        }

        let candidates = [
            rootURL.appendingPathComponent("apps/extension/icons/variants/monitor-v1-mono-128.png"),
            rootURL.appendingPathComponent("apps/extension/icons/variants/monitor-v1-mono-48.png"),
            rootURL.appendingPathComponent("apps/extension/icons/variants/monitor-v1-mono-32.png"),
            rootURL.appendingPathComponent("apps/extension/dist/icons/variants/monitor-v1-mono-128.png"),
            rootURL.appendingPathComponent("apps/extension/dist/icons/variants/monitor-v1-mono-48.png"),
            rootURL.appendingPathComponent("apps/extension/dist/icons/variants/monitor-v1-mono-32.png"),
        ]

        for iconURL in candidates {
            if let image = NSImage(contentsOf: iconURL) {
                image.size = NSSize(width: 18, height: 18)
                image.isTemplate = true
                baseIconImage = image
                return image
            }
        }

        baseIconLookupFailed = true
        return nil
    }

    private func renderStatusDot(mode: KibitzerMode) -> NSAttributedString {
        return NSAttributedString(
            string: " ●",
            attributes: [
                .font: NSFont.menuBarFont(ofSize: 9),
                .foregroundColor: mode.color,
            ]
        )
    }

    private func renderStatusTitle(mode: KibitzerMode) -> NSAttributedString {
        // Fallback for source checkouts that do not have the template icon assets.
        let title = NSMutableAttributedString(
            string: "K ",
            attributes: [
                .font: NSFont.menuBarFont(ofSize: 13),
                .foregroundColor: NSColor.labelColor,
            ]
        )
        title.append(
            NSAttributedString(
                string: "●",
                attributes: [
                    .font: NSFont.menuBarFont(ofSize: 10),
                    .foregroundColor: mode.color,
                ]
            )
        )
        return title
    }

    private func startServer() {
        kickstartServerLaunchAgent { [weak self] didKickstart in
            guard let self else { return }
            if !didKickstart {
                self.startServerScriptFallback()
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
                self.updateStatus(autostartIfDead: false)
            }
        }
    }

    private func kickstartServerLaunchAgent(completion: @escaping (Bool) -> Void) {
        DispatchQueue.global(qos: .utility).async {
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
            process.arguments = ["kickstart", "-k", "gui/\(getuid())/com.kibitzer.server"]
            do {
                try process.run()
                process.waitUntilExit()
                DispatchQueue.main.async {
                    completion(process.terminationStatus == 0)
                }
            } catch {
                DispatchQueue.main.async {
                    completion(false)
                }
            }
        }
    }

    private func startServerScriptFallback() {
        let runScript = rootURL.appendingPathComponent("scripts/macos_run_server.sh")
        let logDirectory = rootURL.appendingPathComponent("data/logs")
        try? FileManager.default.createDirectory(at: logDirectory, withIntermediateDirectories: true)
        let stdout = logDirectory.appendingPathComponent("macos-menu-bar-server.out.log")
        let stderr = logDirectory.appendingPathComponent("macos-menu-bar-server.err.log")
        FileManager.default.createFile(atPath: stdout.path, contents: nil)
        FileManager.default.createFile(atPath: stderr.path, contents: nil)

        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/bash")
        process.arguments = [runScript.path]
        process.currentDirectoryURL = rootURL
        process.standardOutput = try? FileHandle(forWritingTo: stdout)
        process.standardError = try? FileHandle(forWritingTo: stderr)
        try? process.run()
    }

    @objc private func refreshClicked() {
        updateStatus(autostartIfDead: false)
    }

    @objc private func startServerClicked() {
        attemptedAutostart = true
        startServer()
    }

    @objc private func openLogsClicked() {
        let logDirectory = rootURL.appendingPathComponent("data/logs")
        try? FileManager.default.createDirectory(at: logDirectory, withIntermediateDirectories: true)
        NSWorkspace.shared.open(logDirectory)
    }

    @objc private func quitClicked() {
        timer?.invalidate()
        NSApp.terminate(nil)
    }

}

let rootPath = CommandLine.arguments.dropFirst().first ?? FileManager.default.currentDirectoryPath
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let delegate = KibitzerMenuBarApp(rootURL: URL(fileURLWithPath: rootPath))
app.delegate = delegate
app.run()
