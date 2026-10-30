{
  description = "dither-chat: self-hosted Discord + Signal + Matrix aggregator";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" ];
      forAll = f: nixpkgs.lib.genAttrs systems (s: f nixpkgs.legacyPackages.${s});
      # Everything the hub and its adapters exec at runtime.
      runtimeTools = pkgs: with pkgs; [
        bun
        nodejs_24
        signal-cli          # Signal adapter (linked device, JSON-RPC daemon)
        xvfb                # Discord sandbox: virtual display
        x11vnc              # Discord sandbox: live view for logins and captchas
        chromium            # Discord sandbox: the real web client
        matrix-continuwuity # local Matrix homeserver for the adapter testbed
        sqlite
      ];
    in {
      packages = forAll (pkgs: {
        runtime = pkgs.buildEnv { name = "dither-chat-runtime"; paths = runtimeTools pkgs; };
      });
      devShells = forAll (pkgs: {
        default = pkgs.mkShell { packages = runtimeTools pkgs ++ [ pkgs.typescript ]; };
      });
    };
}
