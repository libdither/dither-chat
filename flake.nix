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
        # dither-ask (docs/approvals.md): ask for approval on your devices, check answers and commits. No npm
        # dependencies, so the package is its sources and bun; the verifier needs git.
        dither-ask = pkgs.writeShellApplication {
          name = "dither-ask";
          runtimeInputs = [ pkgs.bun pkgs.git pkgs.openssh ];
          text = ''exec bun ${./packages/approvals/src}/cli.ts "$@"'';
        };
      });
      devShells = forAll (pkgs: {
        default = pkgs.mkShell { packages = runtimeTools pkgs ++ [ pkgs.typescript ]; };
      });
    };
}
