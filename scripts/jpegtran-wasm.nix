# jpegtran (libjpeg-turbo) built for WASI, for the app to make photos progressive before they upload
# (packages/web/src/progressive, docs/uploads.md "Pictures that sharpen"). Rebuild with scripts/jpegtran-wasm.sh.
# Only jpegtran: the TurboJPEG library and the examples want setjmp, which WASI has not got, and jpegtran does not.
let pkgs = (import <nixpkgs> { }).pkgsCross.wasi32;
in
pkgs.libjpeg_turbo.overrideAttrs (o: {
  pname = "jpegtran-wasi";
  cmakeFlags = (o.cmakeFlags or [ ]) ++ [
    "-DWITH_TURBOJPEG=0"
    "-DWITH_SIMD=0"
    "-DENABLE_SHARED=0"
    "-DCMAKE_C_FLAGS=-O2"
  ];
  buildPhase = "make -j$NIX_BUILD_CORES jpegtran-static";
  installPhase = "mkdir -p $out && cp jpegtran-static $out/jpegtran.wasm && cp ../LICENSE.md ../README.ijg $out/";
  doCheck = false;
  doInstallCheck = false;
  outputs = [ "out" ];
  postFixup = "";
  postInstall = "";
})
