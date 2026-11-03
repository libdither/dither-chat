{
  description = "dither-chat: self-hosted Discord + Signal + Matrix + WhatsApp aggregator";

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
      waBridge = pkgs: pkgs.callPackage ./packages/adapter-whatsapp/bridge/package.nix { };
    in {
      packages = forAll (pkgs: {
        runtime = pkgs.buildEnv { name = "dither-chat-runtime"; paths = runtimeTools pkgs ++ [ (waBridge pkgs) ]; };
        # WhatsApp adapter: whatsmeow as a linked device. The adapter builds this itself when it is not on PATH.
        wa-bridge = waBridge pkgs;
      });
      devShells = forAll (pkgs: {
        default = pkgs.mkShell { packages = runtimeTools pkgs ++ [ pkgs.typescript ]; };
      });
    };
}
