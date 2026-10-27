// Finds faces in still images with Apple's Vision framework.
// Usage: facedetect image1.jpg image2.jpg ...
// Prints one JSON line per image: {"file": ..., "faces": [{"x","y","w","h"}]} with the box in
// fractions of the image, origin at the top left.
import Foundation
import Vision
import CoreGraphics
import ImageIO

for file in CommandLine.arguments.dropFirst() {
    var faces: [[String: Double]] = []
    let url = URL(fileURLWithPath: file)
    if let source = CGImageSourceCreateWithURL(url as CFURL, nil),
       let image = CGImageSourceCreateImageAtIndex(source, 0, nil) {
        let request = VNDetectFaceRectanglesRequest()
        let handler = VNImageRequestHandler(cgImage: image, options: [:])
        try? handler.perform([request])
        for face in request.results ?? [] {
            let b = face.boundingBox // origin at the bottom left
            faces.append(["x": b.minX, "y": 1 - b.maxY, "w": b.width, "h": b.height, "c": Double(face.confidence)])
        }
    }
    let line: [String: Any] = ["file": file, "faces": faces]
    if let data = try? JSONSerialization.data(withJSONObject: line), let text = String(data: data, encoding: .utf8) {
        print(text)
    }
}
