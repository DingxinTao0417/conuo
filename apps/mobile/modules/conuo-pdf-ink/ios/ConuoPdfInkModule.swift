import ExpoModulesCore
import PDFKit

public class ConuoPdfInkModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ConuoPdfInk")

    AsyncFunction("extractPdfPageThumbnails") { (uri: String, maxWidth: Double, promise: Promise) in
      do {
        guard let url = URL(string: uri), url.isFileURL else {
          throw NSError(
            domain: "ConuoPdfInk",
            code: 1,
            userInfo: [NSLocalizedDescriptionKey: "请选择可读取的本机 PDF 文件。"]
          )
        }
        guard let document = PDFDocument(url: url), document.pageCount > 0 else {
          throw NSError(
            domain: "ConuoPdfInk",
            code: 2,
            userInfo: [NSLocalizedDescriptionKey: "无法读取这份 PDF。"]
          )
        }
        let width = max(48, min(maxWidth.isFinite ? maxWidth : 120, 320))
        var thumbs: [String] = []
        thumbs.reserveCapacity(document.pageCount)
        for index in 0..<document.pageCount {
          guard let page = document.page(at: index) else {
            thumbs.append("")
            continue
          }
          let box = page.bounds(for: .cropBox)
          let ratio = box.height > 0 ? box.width / box.height : 0.7
          let size = CGSize(width: width, height: width / max(ratio, 0.2))
          let image = page.thumbnail(of: size, for: .cropBox)
          if let data = image.jpegData(compressionQuality: 0.72) {
            thumbs.append(data.base64EncodedString())
          } else {
            thumbs.append("")
          }
        }
        promise.resolve(["pageCount": document.pageCount, "thumbnails": thumbs])
      } catch {
        promise.reject(error)
      }
    }

    AsyncFunction("extractPdfText") { (uri: String, promise: Promise) in
      do {
        guard let url = URL(string: uri), url.isFileURL else {
          throw NSError(
            domain: "ConuoPdfInk",
            code: 1,
            userInfo: [NSLocalizedDescriptionKey: "请选择可读取的本机 PDF 文件。"]
          )
        }
        guard let document = PDFDocument(url: url), document.pageCount > 0 else {
          throw NSError(
            domain: "ConuoPdfInk",
            code: 2,
            userInfo: [NSLocalizedDescriptionKey: "无法读取这份 PDF。"]
          )
        }
        guard !document.isLocked else {
          throw NSError(
            domain: "ConuoPdfInk",
            code: 3,
            userInfo: [NSLocalizedDescriptionKey: "这份 PDF 受密码保护，暂时无法提取正文。"]
          )
        }
        let pages = (0..<document.pageCount).map { index in
          document.page(at: index)?.string ?? ""
        }
        promise.resolve(["pageCount": document.pageCount, "pages": pages])
      } catch {
        promise.reject(error)
      }
    }

    View(ConuoPdfInkView.self) {
      Events("onPageChanged", "onDrawingChanged", "onZoomChanged", "onLocalSnapshot", "onToolToggled")

      Prop("documentUri") { (view: ConuoPdfInkView, uri: String) in
        view.setDocumentUri(uri)
      }

      Prop("snapshotNamespace") { (view: ConuoPdfInkView, namespace: String) in
        view.setSnapshotNamespace(namespace)
      }

      Prop("allowsFingerDrawing") { (view: ConuoPdfInkView, enabled: Bool) in
        view.setAllowsFingerDrawing(enabled)
      }

      Prop("annotationMode") { (view: ConuoPdfInkView, enabled: Bool) in
        view.setAnnotationMode(enabled)
      }

      Prop("displayMode") { (view: ConuoPdfInkView, mode: String) in
        view.setDisplayMode(mode)
      }

      Prop("selectedTool") { (view: ConuoPdfInkView, tool: String) in
        view.setSelectedTool(tool)
      }

      Prop("selectedColor") { (view: ConuoPdfInkView, color: String) in
        view.setSelectedColor(color)
      }

      Prop("currentPage") { (view: ConuoPdfInkView, page: Int) in
        view.go(toPage: page)
      }

      Prop("zoomStep") { (view: ConuoPdfInkView, step: Int) in
        view.setZoomStep(step)
      }

      Prop("undoToken") { (view: ConuoPdfInkView, token: Int) in
        view.undo(token: token)
      }

      Prop("redoToken") { (view: ConuoPdfInkView, token: Int) in
        view.redo(token: token)
      }

    }
  }
}
