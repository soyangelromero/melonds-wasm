$ErrorActionPreference = "Continue"

$root = Split-Path -Parent $PSScriptRoot
$image = "emscripten/emsdk:6.0.13"
$target = if ($args.Count -gt 0) { $args[0] } else { "hello" }

switch ($target) {
  "hello" {
    New-Item -ItemType Directory -Force -Path (Join-Path $root "dist") | Out-Null
    docker run --rm `
      -v "${root}:/src" `
      -w /src `
      $image `
      em++ core/hello/hello.cpp `
        -o dist/hello.js `
        -O3 `
        -pthread `
        -msimd128 `
        "-sUSE_PTHREADS=1" `
        "-sPTHREAD_POOL_SIZE=2" `
        "-sMODULARIZE=1" `
        "-sEXPORT_ES6=1" `
        "-sENVIRONMENT=web,worker" `
        "-sEXPORTED_FUNCTIONS=_mds_hello,_mds_pthreads_enabled" `
        "-sEXPORTED_RUNTIME_METHODS=ccall,cwrap" `
        "-sALLOW_MEMORY_GROWTH=1"
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  }
  default {
    Write-Error "Unknown target: $target (available: hello)"
    exit 2
  }
}
