// browxai-launcher: the main executable of Browxai.app (RFC 0012).
//
// A compiled launcher is the app's main executable, so the running program has the
// app's code identity. It finds the bundled Node binary and the built browxai from
// its own location, and replaces itself with node (execve), so no interpreter or
// PATH lookup stands between the app and the process that does the work.
//
//   browxai-launcher run [--socket PATH] [SERVE ARGS...]
//   browxai-launcher cli ARGS...
//   browxai-launcher helper ARGS...
//   browxai-launcher login-item status|register|unregister|start
//   browxai-launcher version
//
// Build (done by scripts/macos/build-app.sh, never by hand in the repository):
//   swiftc -O -target arm64-apple-macos12.0 main.swift -o browxai-launcher-arm64
//
// Single file, no package manifest, no Xcode project. ServiceManagement is linked
// by the import. The deployment target is 12.0 and the SMAppService calls sit
// behind an availability check, so the launcher can print the launchctl fallback on
// a Mac that lacks the API. The app's own floor is LSMinimumSystemVersion in
// Info.plist.

import Darwin
import Foundation
import ServiceManagement

// MARK: - Constants

let launcherVersion = "1"
/// Directory name under ~/Library/Application Support and ~/Library/Logs. Fixed on
/// purpose: renaming the app must not move the socket.
let appSupportDirName = "Browxai"
let socketFileName = "browxai.sock"
/// sockaddr_un.sun_path holds 104 bytes on macOS, the last one for the NUL.
let maxSocketPathBytes = 103
let defaultBundleID = "com.kalebtec.browxai"
/// Search path for the tools the daemon starts (adb, xcrun, password manager CLIs).
/// System directories first, so a Homebrew tool cannot shadow a system one.
let agentPath =
    "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/local/sbin"
/// The only variables besides BROWX_* that the login agent passes on.
let agentPassThroughKeys = ["HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE"]
let maxLogBytes: Int64 = 5_000_000

// MARK: - Output helpers

func fail(_ message: String, code: Int32 = 1) -> Never {
    FileHandle.standardError.write(Data(("browxai-launcher: " + message + "\n").utf8))
    exit(code)
}

func note(_ message: String) {
    FileHandle.standardError.write(Data(("browxai-launcher: " + message + "\n").utf8))
}

let usageText = """
    usage: browxai-launcher <command>

      run [--socket PATH] [SERVE ARGS...]
          Start the daemon: node dist/cli.js serve --socket PATH. The socket comes from
          --socket, then BROWX_SOCKET, then ~/Library/Application Support/Browxai/run/browxai.sock.
      cli ARGS...
          Run the bundled browxai CLI with ARGS. This is what the browxai command on PATH does.
      helper ARGS...
          Run the bundled cloud helper, when this app has one.
      login-item status|register|unregister|start
          Show, add or remove the login agent that runs `run` at login. `start` asks
          launchd to start an agent that is registered and stopped. It registers nothing.
      version
          Print the launcher and app versions.

    """

func usage(_ code: Int32) -> Never {
    if code == 0 {
        print(usageText, terminator: "")
    } else {
        FileHandle.standardError.write(Data(usageText.utf8))
    }
    exit(code)
}

// MARK: - Where the bundle is

struct Layout {
    let contents: URL

    var infoPlist: String { contents.appendingPathComponent("Info.plist").path }
    var launcher: String { contents.appendingPathComponent("MacOS/browxai-launcher").path }
    var node: String { contents.appendingPathComponent("Resources/node/bin/node").path }
    var cli: String { contents.appendingPathComponent("Resources/app/dist/cli.js").path }
    var helper: String { contents.appendingPathComponent("Helpers/browxai-cloud").path }
}

/// The bundle that holds this executable, found from the executable's real path.
/// Never from PATH, never from the working directory, so the app works wherever it
/// is installed.
func locateLayout() -> Layout {
    var size: UInt32 = 0
    _ = _NSGetExecutablePath(nil, &size)
    var buffer = [CChar](repeating: 0, count: Int(size) + 1)
    guard _NSGetExecutablePath(&buffer, &size) == 0 else {
        fail("cannot read the path of its own executable")
    }
    guard let resolved = realpath(buffer, nil) else {
        fail("cannot resolve the path of its own executable")
    }
    let executable = String(cString: resolved)
    free(resolved)

    let macOSDir = URL(fileURLWithPath: executable).deletingLastPathComponent()
    let contents = macOSDir.deletingLastPathComponent()
    guard macOSDir.lastPathComponent == "MacOS", contents.lastPathComponent == "Contents",
        FileManager.default.fileExists(atPath: contents.appendingPathComponent("Info.plist").path)
    else {
        fail("it has to run from inside the app: Browxai.app/Contents/MacOS/browxai-launcher")
    }
    return Layout(contents: contents)
}

func infoValue(_ layout: Layout, _ key: String) -> String? {
    guard let data = FileManager.default.contents(atPath: layout.infoPlist),
        let object = try? PropertyListSerialization.propertyList(from: data, options: [], format: nil),
        let dictionary = object as? [String: Any]
    else { return nil }
    return dictionary[key] as? String
}

func requireExecutable(_ path: String, what: String) {
    if access(path, X_OK) != 0 {
        fail("\(what) is missing or not executable: \(path). The app is incomplete, so reinstall it.")
    }
}

func requireReadable(_ path: String, what: String) {
    if access(path, R_OK) != 0 {
        fail("\(what) is missing or unreadable: \(path). The app is incomplete, so reinstall it.")
    }
}

// MARK: - Socket path

func expandTilde(_ path: String) -> String {
    if path == "~" { return NSHomeDirectory() }
    if path.hasPrefix("~/") { return NSHomeDirectory() + String(path.dropFirst(1)) }
    return path
}

func defaultSocketPath() -> String {
    return NSHomeDirectory() + "/Library/Application Support/\(appSupportDirName)/run/\(socketFileName)"
}

struct SocketChoice {
    let path: String
    /// True for the default path, whose directory this launcher owns and keeps private.
    let isDefault: Bool
}

func chooseSocket(explicit: String?) -> SocketChoice {
    var raw: String?
    if let explicit = explicit, !explicit.isEmpty {
        raw = explicit
    } else if let fromEnv = ProcessInfo.processInfo.environment["BROWX_SOCKET"], !fromEnv.isEmpty {
        raw = fromEnv
    }
    let isDefault = raw == nil
    let path = expandTilde(raw ?? defaultSocketPath())
    guard path.hasPrefix("/") else {
        fail("the socket path has to be absolute: \(path)")
    }
    if path.utf8.count > maxSocketPathBytes {
        fail(
            "the socket path is \(path.utf8.count) bytes and macOS allows \(maxSocketPathBytes). Use a shorter path: \(path)"
        )
    }
    return SocketChoice(path: path, isDefault: isDefault)
}

/// Make the directory that will hold the socket. The default directory must belong
/// to the current user and end up mode 0700. For a path the user chose, the
/// directory is created when missing and an existing one is left alone: the daemon
/// creates the socket itself with mode 0600 either way.
func prepareSocketDirectory(_ socket: SocketChoice) {
    let directory = (socket.path as NSString).deletingLastPathComponent
    var info = stat()
    if lstat(directory, &info) == 0 {
        guard (info.st_mode & S_IFMT) == S_IFDIR else {
            fail("\(directory) is not a plain directory, so the socket cannot go there")
        }
    } else {
        do {
            try FileManager.default.createDirectory(
                atPath: directory, withIntermediateDirectories: true,
                attributes: [.posixPermissions: 0o700])
        } catch {
            fail("cannot create \(directory): \(error.localizedDescription)")
        }
        if lstat(directory, &info) != 0 {
            fail("cannot read \(directory) after creating it")
        }
    }
    guard socket.isDefault else { return }
    guard info.st_uid == getuid() else {
        fail("\(directory) is not owned by you, so the socket cannot go there")
    }
    if info.st_mode & 0o077 != 0 {
        if chmod(directory, 0o700) != 0 {
            fail("cannot restrict \(directory) to its owner: \(String(cString: strerror(errno)))")
        }
    }
}

// MARK: - Running node

/// Replace this process with `path`. Does not return.
func execReplacing(_ path: String, arguments: [String], environment: [String: String]) -> Never {
    var argv: [UnsafeMutablePointer<CChar>?] = arguments.map { strdup($0) }
    argv.append(nil)
    var envp: [UnsafeMutablePointer<CChar>?] = environment.map { strdup("\($0.key)=\($0.value)") }
    envp.append(nil)
    execve(path, &argv, &envp)
    let reason = String(cString: strerror(errno))
    fail("cannot start \(path): \(reason)")
}

/// Send stdout and stderr of the login agent to ~/Library/Logs/Browxai/browxai.log
/// (mode 0600), unless they already go to a terminal. launchd would drop them.
func redirectAgentLogs() {
    if isatty(2) != 0 { return }
    let directory = NSHomeDirectory() + "/Library/Logs/\(appSupportDirName)"
    do {
        try FileManager.default.createDirectory(
            atPath: directory, withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700])
    } catch {
        return
    }
    let logPath = directory + "/browxai.log"
    var info = stat()
    if lstat(logPath, &info) == 0 && Int64(info.st_size) > maxLogBytes {
        _ = rename(logPath, logPath + ".1")
    }
    let fd = Darwin.open(logPath, O_WRONLY | O_CREAT | O_APPEND, 0o600)
    if fd < 0 { return }
    _ = dup2(fd, 1)
    _ = dup2(fd, 2)
    if fd > 2 { close(fd) }
}

func agentEnvironment(socket: String) -> [String: String] {
    let source = ProcessInfo.processInfo.environment
    var environment: [String: String] = ["PATH": agentPath]
    for key in agentPassThroughKeys {
        if let value = source[key], !value.isEmpty { environment[key] = value }
    }
    if environment["HOME"] == nil { environment["HOME"] = NSHomeDirectory() }
    for (key, value) in source where key.hasPrefix("BROWX_") {
        environment[key] = value
    }
    environment["BROWX_SOCKET"] = socket
    return environment
}

func runDaemon(_ layout: Layout, arguments: [String]) -> Never {
    var explicitSocket: String?
    var forwarded: [String] = []
    var index = 0
    while index < arguments.count {
        let argument = arguments[index]
        if argument == "--socket" {
            guard index + 1 < arguments.count else { fail("--socket needs a path", code: 2) }
            explicitSocket = arguments[index + 1]
            index += 2
        } else if argument.hasPrefix("--socket=") {
            explicitSocket = String(argument.dropFirst("--socket=".count))
            index += 1
        } else {
            forwarded.append(argument)
            index += 1
        }
    }

    requireExecutable(layout.node, what: "the bundled node binary")
    requireReadable(layout.cli, what: "the bundled browxai (dist/cli.js)")

    // The directories and the log this launcher creates are private to the user. The
    // mask goes back before the exec, so the daemon keeps the umask it would have had
    // under a terminal. The daemon sets mode 0600 on the socket itself.
    let previousMask = umask(0o077)
    let socket = chooseSocket(explicit: explicitSocket)
    prepareSocketDirectory(socket)
    redirectAgentLogs()
    _ = umask(previousMask)

    let serveCommand = [layout.node, layout.cli, "serve", "--socket", socket.path] + forwarded
    execReplacing(
        layout.node, arguments: serveCommand, environment: agentEnvironment(socket: socket.path))
}

func runCLI(_ layout: Layout, arguments: [String]) -> Never {
    requireExecutable(layout.node, what: "the bundled node binary")
    requireReadable(layout.cli, what: "the bundled browxai (dist/cli.js)")
    // A shell session keeps its own environment. Only the socket gets a default, so
    // `browxai call` and `browxai tools` find the app's daemon.
    var environment = ProcessInfo.processInfo.environment
    if (environment["BROWX_SOCKET"] ?? "").isEmpty {
        environment["BROWX_SOCKET"] = defaultSocketPath()
    }
    execReplacing(
        layout.node, arguments: [layout.node, layout.cli] + arguments, environment: environment)
}

func runHelper(_ layout: Layout, arguments: [String]) -> Never {
    if access(layout.helper, X_OK) != 0 {
        fail("this build of the app has no cloud helper (Contents/Helpers/browxai-cloud)")
    }
    var environment = ProcessInfo.processInfo.environment
    if (environment["BROWX_SOCKET"] ?? "").isEmpty {
        environment["BROWX_SOCKET"] = defaultSocketPath()
    }
    execReplacing(layout.helper, arguments: [layout.helper] + arguments, environment: environment)
}

// MARK: - Login item

func xmlEscape(_ text: String) -> String {
    return text
        .replacingOccurrences(of: "&", with: "&amp;")
        .replacingOccurrences(of: "<", with: "&lt;")
        .replacingOccurrences(of: ">", with: "&gt;")
        .replacingOccurrences(of: "\"", with: "&quot;")
}

/// Printed when SMAppService is not there. The output is a shell script that
/// writes a plain launchd agent with absolute paths and loads it. A launchd plist
/// outside the bundle cannot use BundleProgram, so the paths are the real ones.
func printLaunchctlFallback(_ layout: Layout, label: String, reason: String) {
    let launcher = xmlEscape(layout.launcher)
    let plistPath = "$HOME/Library/LaunchAgents/\(label).plist"
    print("# \(reason)")
    print("# To run the browxai daemon at login with launchd directly, run these commands:")
    print("mkdir -p \"$HOME/Library/LaunchAgents\"")
    print("cat > \"\(plistPath)\" <<'EOF'")
    print(
        """
        <?xml version="1.0" encoding="UTF-8"?>
        <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
        <plist version="1.0">
        <dict>
          <key>Label</key>
          <string>\(xmlEscape(label))</string>
          <key>ProgramArguments</key>
          <array>
            <string>\(launcher)</string>
            <string>run</string>
          </array>
          <key>RunAtLoad</key>
          <true/>
          <key>KeepAlive</key>
          <dict>
            <key>SuccessfulExit</key>
            <false/>
          </dict>
        </dict>
        </plist>
        """)
    print("EOF")
    print("launchctl bootstrap \"gui/$(id -u)\" \"\(plistPath)\"")
    print("# To remove it again:")
    print("launchctl bootout \"gui/$(id -u)/\(label)\" && rm \"\(plistPath)\"")
}

@available(macOS 13.0, *)
func describe(_ status: SMAppService.Status) -> String {
    switch status {
    case .enabled:
        return "enabled: the login agent is registered and allowed to run"
    case .requiresApproval:
        return
            "requires approval: switch Browxai on in System Settings, General, Login Items & Extensions"
    case .notRegistered:
        return "not registered: run `browxai-launcher login-item register`"
    case .notFound:
        return
            "not found: the app has no agent plist for SMAppService. Reinstall the app, and run it from a signed copy"
    @unknown default:
        return "unknown status (\(status.rawValue))"
    }
}

/// Ask launchd to start the agent with this label in the user's gui domain. Without
/// `-k`, kickstart leaves an agent that is already running alone. It starts only a
/// job launchd already knows, so it cannot register one.
func kickstartAgent(label: String) -> Never {
    let target = "gui/\(getuid())/\(label)"
    let launchctl = Process()
    launchctl.executableURL = URL(fileURLWithPath: "/bin/launchctl")
    launchctl.arguments = ["kickstart", target]
    let errors = Pipe()
    launchctl.standardOutput = FileHandle.nullDevice
    launchctl.standardError = errors
    do {
        try launchctl.run()
    } catch {
        fail("cannot run /bin/launchctl: \(error.localizedDescription)")
    }
    let said = errors.fileHandleForReading.readDataToEndOfFile()
    launchctl.waitUntilExit()
    if launchctl.terminationStatus == 0 {
        print("started: launchd was asked to start \(label)")
        exit(0)
    }
    let detail = (String(data: said, encoding: .utf8) ?? "")
        .trimmingCharacters(in: .whitespacesAndNewlines)
    note(
        "nothing was started: launchctl kickstart \(target) exited \(launchctl.terminationStatus)"
            + (detail.isEmpty ? "" : " (\(detail))"))
    exit(1)
}

func loginItem(_ layout: Layout, action: String) -> Never {
    let bundleID = infoValue(layout, "CFBundleIdentifier") ?? defaultBundleID
    let label = bundleID + ".agent"
    let plistName = label + ".plist"

    guard #available(macOS 13.0, *) else {
        // Without SMAppService the agent, when there is one, is the plain launchd agent
        // of the fallback below, under the same label.
        if action == "start" { kickstartAgent(label: label) }
        let version = ProcessInfo.processInfo.operatingSystemVersionString
        note("the login item API (SMAppService) needs macOS 13 or later, and this Mac runs \(version).")
        printLaunchctlFallback(
            layout, label: label, reason: "SMAppService is not available on this macOS version.")
        exit(1)
    }

    let service = SMAppService.agent(plistName: plistName)
    switch action {
    case "status":
        let status = service.status
        print(describe(status))
        exit(status == .enabled ? 0 : 2)
    case "register":
        do {
            try service.register()
        } catch {
            note("could not register the login agent: \(error.localizedDescription)")
            note("A copy that is not signed with a Developer ID certificate cannot register. The status is: \(describe(service.status))")
            note("The launchctl route below works without SMAppService.")
            printLaunchctlFallback(
                layout, label: label, reason: "SMAppService.register failed.")
            exit(1)
        }
        print(describe(service.status))
        exit(0)
    case "unregister":
        do {
            try service.unregister()
        } catch {
            fail("could not unregister the login agent: \(error.localizedDescription)")
        }
        print(describe(service.status))
        exit(0)
    case "start":
        let status = service.status
        guard status == .enabled else {
            print("nothing was started. The login agent is \(describe(status))")
            exit(2)
        }
        kickstartAgent(label: label)
    default:
        usage(2)
    }
}

// MARK: - Main

let commandLineArguments = Array(CommandLine.arguments.dropFirst())
guard let command = commandLineArguments.first else { usage(2) }
let rest = Array(commandLineArguments.dropFirst())

switch command {
case "run":
    runDaemon(locateLayout(), arguments: rest)
case "cli":
    runCLI(locateLayout(), arguments: rest)
case "helper":
    runHelper(locateLayout(), arguments: rest)
case "login-item":
    guard rest.count == 1 else { usage(2) }
    loginItem(locateLayout(), action: rest[0])
case "version", "--version", "-v":
    let layout = locateLayout()
    let appVersion = infoValue(layout, "CFBundleShortVersionString") ?? "unknown"
    print("browxai \(appVersion) (macOS app, launcher \(launcherVersion))")
    exit(0)
case "help", "--help", "-h":
    usage(0)
default:
    note("unknown command: \(command)")
    usage(2)
}
