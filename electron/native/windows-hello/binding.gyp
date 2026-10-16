{
  "targets": [
    {
      "target_name": "windows_hello",
      "sources": ["windows_hello.cc"],
      "conditions": [
        [
          "OS=='win'",
          {
            "libraries": ["windowsapp.lib"],
            "msvs_settings": {
              "VCCLCompilerTool": {
                "AdditionalOptions": ["/std:c++20", "/EHsc", "/permissive-"]
              }
            }
          }
        ]
      ]
    }
  ]
}
