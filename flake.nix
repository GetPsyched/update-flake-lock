{
  description = "Development environment for the Update Flake Lock action for GitHub.";

  inputs = {
    flake-schemas.url = "https://flakehub.com/f/DeterminateSystems/flake-schemas/*.tar.gz";
    nixpkgs.url = "https://flakehub.com/f/NixOS/nixpkgs/0.1.0.tar.gz";
  };

  outputs = { self, flake-schemas, nixpkgs }:
    let
      nameValuePair = name: value: { inherit name value; };
      genAttrs = names: f: builtins.listToAttrs (map (n: nameValuePair n (f n)) names);

      allSystems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      forAllSystems = f: genAttrs allSystems
        (system: f {
          inherit system;
          pkgs = import nixpkgs { inherit system; };
        });
    in
    {
      schemas = flake-schemas.schemas;

      devShells = forAllSystems ({ system, pkgs, ... }: {
        default = with pkgs; stdenv.mkDerivation {
          name = "update-flake-lock-devshell";
          buildInputs = [
            shellcheck
            nixpkgs-fmt
            nodePackages_latest.pnpm
            nodePackages_latest.typescript-language-server
          ];
          src = self;
        };
      });
    };
}
