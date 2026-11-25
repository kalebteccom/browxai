# template: Cask for the signed Browxai macOS app (docs/rfcs/0012-signed-macos-app.md).
# template: Do not copy this file into a tap by hand. scripts/macos/make-cask.sh fills the
# template: double-underscore placeholders (version, SHA-256, architecture) from the release zip and
# template: prints the finished cask. Lines that end in "helper-only" stay only when the app was
# template: built with the bundled cloud helper (make-cask.sh --with-helper).
cask "browxai" do
  version "__VERSION__"
  sha256 "__SHA256__"

  url "https://github.com/kalebteccom/browxai/releases/download/v#{version}/browxai-#{version}-macos-__ARCH__.zip",
      verified: "github.com/kalebteccom/browxai/"
  name "Browxai"
  desc "Browser control for AI agents, hosted by a signed app"
  homepage "https://browxai.com/"

  livecheck do
    url :url
    strategy :github_latest
  end

  depends_on arch: :__ARCH_SYMBOL__
  depends_on macos: :ventura

  app "Browxai.app"
  binary "#{appdir}/Browxai.app/Contents/Resources/bin/browxai"
  binary "#{appdir}/Browxai.app/Contents/Resources/bin/browxai-cloud" # helper-only

  uninstall launchctl: "com.kalebtec.browxai.agent",
            quit:      "com.kalebtec.browxai"

  # The workspace (~/.browxai: profiles, saved logins, replay archives) is user data and stays.
  zap trash: [
    "~/Library/Application Support/Browxai",
    "~/Library/Caches/com.kalebtec.browxai",
    "~/Library/LaunchAgents/com.kalebtec.browxai.agent.plist",
    "~/Library/Preferences/com.kalebtec.browxai.plist",
  ]
end
