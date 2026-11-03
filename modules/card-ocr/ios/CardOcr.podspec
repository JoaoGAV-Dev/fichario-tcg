Pod::Spec.new do |s|
  s.name           = 'CardOcr'
  s.version        = '1.0.0'
  s.summary        = 'OCR on-device (ML Kit) para o rodapé das cartas'
  s.description    = 'Lê texto de fotos com o Google ML Kit, sem internet.'
  s.author         = ''
  s.homepage       = 'https://github.com/'
  s.license        = 'MIT'
  s.platforms      = { :ios => '16.4' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.dependency 'GoogleMLKit/TextRecognition'

  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
  s.source_files = "**/*.{h,m,swift}"
end
