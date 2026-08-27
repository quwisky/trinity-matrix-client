{
  "targets": [
    {
      "target_name": "native_location",
      "conditions": [
        ["OS=='linux'", {
          "sources": ["src/linux.cc"],
          "cflags": ["<!@(pkg-config --cflags gio-2.0)"],
          "libraries": ["<!@(pkg-config --libs gio-2.0)"],
          "cflags_cc": ["-std=c++17"]
        }],
        ["OS=='mac'", {
          "sources": ["src/macos.mm"],
          "xcode_settings": {
            "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
            "CLANG_ENABLE_OBJC_ARC": "YES",
            "OTHER_LDFLAGS": ["-framework CoreLocation", "-framework Foundation"]
          }
        }],
        ["OS=='win'", {
          "sources": ["src/windows.cc"],
          "libraries": ["windowsapp.lib"],
          "msvs_settings": {
            "VCCLCompilerTool": {
              "AdditionalOptions": ["/std:c++17"]
            }
          }
        }]
      ]
    }
  ]
}
