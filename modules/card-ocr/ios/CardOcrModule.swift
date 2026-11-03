import ExpoModulesCore
import MLKitTextRecognition
import MLKitVision

// Versão iOS (não testada ainda — o foco atual é o APK Android).
public class CardOcrModule: Module {
  private lazy var recognizer = TextRecognizer.textRecognizer(options: TextRecognizerOptions())

  public func definition() -> ModuleDefinition {
    Name("CardOcr")

    Function("isAvailable") { true }

    AsyncFunction("recognizeAsync") { (uri: String, promise: Promise) in
      let path = URL(string: uri)?.path ?? uri
      guard let image = UIImage(contentsOfFile: path) else {
        promise.reject("ERR_IMAGE", "Não consegui abrir a imagem")
        return
      }
      let vision = VisionImage(image: image)
      vision.orientation = image.imageOrientation
      self.recognizer.process(vision) { result, error in
        if let error = error {
          promise.reject("ERR_OCR", error.localizedDescription)
          return
        }
        var lines: [[String: Any]] = []
        for block in result?.blocks ?? [] {
          for line in block.lines {
            let f = line.frame
            lines.append(["text": line.text, "x": f.minX, "y": f.minY, "width": f.width, "height": f.height])
          }
        }
        promise.resolve([
          "text": result?.text ?? "",
          "lines": lines,
          "width": image.size.width * image.scale,
          "height": image.size.height * image.scale,
        ])
      }
    }
  }
}
