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
}

final class KibitzerMenuBarApp: NSObject, NSApplicationDelegate {
    private let rootURL: URL
    private let healthURL = URL(string: "http://127.0.0.1:8765/health")!
    private let statusItem = NSStatusBar.system.statusItem(withLength: 28)
    private let menu = NSMenu()
    private let statusMenuItem = NSMenuItem(title: "Kibitzer: starting", action: nil, keyEquivalent: "")
    private let startServerMenuItem = NSMenuItem(title: "Start server", action: #selector(startServerClicked), keyEquivalent: "s")
    private let refreshMenuItem = NSMenuItem(title: "Refresh status", action: #selector(refreshClicked), keyEquivalent: "r")
    private let openHealthMenuItem = NSMenuItem(title: "Open health", action: #selector(openHealthClicked), keyEquivalent: "h")
    private let openLogsMenuItem = NSMenuItem(title: "Open logs", action: #selector(openLogsClicked), keyEquivalent: "l")
    private var baseIconImage: NSImage?
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
        for item in [refreshMenuItem, startServerMenuItem, openHealthMenuItem, openLogsMenuItem] {
            item.target = self
            menu.addItem(item)
        }
        menu.addItem(NSMenuItem.separator())
        let quitItem = NSMenuItem(title: "Quit Kibitzer Menu Bar", action: #selector(quitClicked), keyEquivalent: "q")
        quitItem.target = self
        menu.addItem(quitItem)
        statusItem.button?.imagePosition = .imageOnly
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
        var request = URLRequest(url: healthURL)
        request.timeoutInterval = 2
        URLSession.shared.dataTask(with: request) { data, _, error in
            let mode: KibitzerMode
            defer {
                DispatchQueue.main.async {
                    completion(mode)
                }
            }
            guard error == nil, let data else {
                mode = .dead
                return
            }
            let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            let rawMode = object?["mode"] as? String
            mode = KibitzerMode(rawValue: rawMode ?? "") ?? .unknown
        }.resume()
    }

    private func render(mode: KibitzerMode) {
        statusMenuItem.title = "Kibitzer: \(mode.label)"
        startServerMenuItem.isEnabled = mode == .dead
        statusItem.button?.toolTip = "Kibitzer: \(mode.label)"
        if let image = renderStatusIcon(mode: mode) {
            statusItem.length = 28
            statusItem.button?.image = image
            statusItem.button?.attributedTitle = NSAttributedString(string: "")
        } else {
            statusItem.length = NSStatusItem.variableLength
            statusItem.button?.image = nil
            statusItem.button?.attributedTitle = renderStatusTitle(mode: mode)
        }
    }

    private func renderStatusIcon(mode: KibitzerMode) -> NSImage? {
        guard let baseIcon = loadBaseIcon() else { return nil }
        let canvasSize = NSSize(width: 22, height: 22)
        let iconRect = NSRect(x: 1, y: 2, width: 18, height: 18)
        let dotRect = NSRect(x: 14.5, y: 1.5, width: 6.5, height: 6.5)
        let haloRect = dotRect.insetBy(dx: -1.5, dy: -1.5)
        let image = NSImage(size: canvasSize)

        image.lockFocus()
        NSGraphicsContext.current?.imageInterpolation = .high
        let iconAlpha: CGFloat = mode == .dead ? 0.45 : 1.0
        baseIcon.draw(
            in: iconRect,
            from: NSRect(origin: .zero, size: baseIcon.size),
            operation: .sourceOver,
            fraction: iconAlpha
        )
        NSColor.windowBackgroundColor.withAlphaComponent(0.92).setFill()
        NSBezierPath(ovalIn: haloRect).fill()
        mode.color.setFill()
        NSBezierPath(ovalIn: dotRect).fill()
        image.unlockFocus()

        image.isTemplate = false
        return image
    }

    private func loadBaseIcon() -> NSImage? {
        if let baseIconImage = baseIconImage {
            return baseIconImage
        }

        let candidates = [
            rootURL.appendingPathComponent("apps/extension/icons/icon-128.png"),
            rootURL.appendingPathComponent("apps/extension/dist/icons/icon-128.png"),
        ]

        for iconURL in candidates {
            if let image = NSImage(contentsOf: iconURL) {
                image.isTemplate = false
                baseIconImage = image
                return image
            }
        }

        return nil
    }

    private func renderStatusTitle(mode: KibitzerMode) -> NSAttributedString {
        // Fallback for source checkouts that do not have the shared icon assets.
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
        if kickstartServerLaunchAgent() {
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
                self.updateStatus(autostartIfDead: false)
            }
            return
        }
        startServerScriptFallback()
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
            self.updateStatus(autostartIfDead: false)
        }
    }

    private func kickstartServerLaunchAgent() -> Bool {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        process.arguments = ["kickstart", "-k", "gui/\(getuid())/com.kibitzer.server"]
        do {
            try process.run()
            process.waitUntilExit()
            return process.terminationStatus == 0
        } catch {
            return false
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

    @objc private func openHealthClicked() {
        NSWorkspace.shared.open(healthURL)
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
