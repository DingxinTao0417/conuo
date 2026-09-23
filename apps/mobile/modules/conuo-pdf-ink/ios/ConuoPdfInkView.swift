import ExpoModulesCore
import PDFKit
import PencilKit
import UIKit
import CryptoKit

/// WP0's smallest native vertical slice: PDFKit owns the document and page
/// lifecycle while PencilKit owns the high-frequency input surface. JavaScript
/// receives page and dirty-state events instead of individual Pencil points.
final class ConuoPdfInkView: ExpoView {
  let onPageChanged = EventDispatcher()
  let onDrawingChanged = EventDispatcher()
  let onZoomChanged = EventDispatcher()
  let onLocalSnapshot = EventDispatcher()
  let onToolToggled = EventDispatcher()

  private let pdfView = PDFView()
  private var overlayProvider: ConuoPageOverlayProvider!
  private var documentUri: String?
  private var snapshotNamespace = "default"
  private var snapshotWorkItems: [Int: DispatchWorkItem] = [:]
  private var pageChangedObserver: NSObjectProtocol?
  private var scaleChangedObserver: NSObjectProtocol?
  private var allowsFingerDrawing = false
  private var lastInkToolName = "pen"
  private var pencilInteraction: UIPencilInteraction?

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)

    clipsToBounds = true
    backgroundColor = UIColor(white: 0.92, alpha: 1)

    overlayProvider = ConuoPageOverlayProvider(owner: self)
    pdfView.pageOverlayViewProvider = overlayProvider
    pdfView.displayMode = .singlePageContinuous
    pdfView.displayDirection = .vertical
    pdfView.displayBox = .cropBox
    // PDFKit normally hit-tests page gestures itself (scrolling, selection).
    // Markup mode routes them to the page overlay so PKCanvasView can receive
    // Pencil input instead of letting PDFView treat it as a page swipe.
    pdfView.isInMarkupMode = true
    pdfView.autoScales = true
    pdfView.maxScaleFactor = 5
    pdfView.backgroundColor = UIColor(white: 0.92, alpha: 1)
    pdfView.usePageViewController(false)
    addSubview(pdfView)

    // Apple Pencil double-tap toggles eraser ↔ last pen (custom tool bar, not PKToolPicker).
    let interaction = UIPencilInteraction()
    interaction.delegate = self
    addInteraction(interaction)
    pencilInteraction = interaction

    pageChangedObserver = NotificationCenter.default.addObserver(
      forName: Notification.Name.PDFViewPageChanged,
      object: pdfView,
      queue: .main
    ) { [weak self] _ in
      self?.emitCurrentPage()
    }
    scaleChangedObserver = NotificationCenter.default.addObserver(
      forName: Notification.Name.PDFViewScaleChanged,
      object: pdfView,
      queue: .main
    ) { [weak self] _ in
      self?.emitZoom()
    }

    loadDocument(uri: nil)
  }

  deinit {
    for item in snapshotWorkItems.values {
      item.cancel()
    }
    if let pageChangedObserver {
      NotificationCenter.default.removeObserver(pageChangedObserver)
    }
    if let scaleChangedObserver {
      NotificationCenter.default.removeObserver(scaleChangedObserver)
    }
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    pdfView.frame = bounds
  }

  func setDocumentUri(_ uri: String) {
    let normalized = uri.trimmingCharacters(in: .whitespacesAndNewlines)
    let nextUri = normalized.isEmpty ? nil : normalized
    guard nextUri != documentUri else { return }
    documentUri = nextUri
    loadDocument(uri: nextUri)
  }

  func setSnapshotNamespace(_ namespace: String) {
    let normalized = Self.safePathComponent(namespace)
    guard !normalized.isEmpty else { return }
    snapshotNamespace = normalized
    overlayProvider.snapshotNamespace = normalized
    overlayProvider.restoreVisibleDrawings()
  }

  func setAllowsFingerDrawing(_ enabled: Bool) {
    allowsFingerDrawing = enabled
    overlayProvider.allowsFingerDrawing = enabled
    overlayProvider.updateDrawingPolicies()
  }

  func setAnnotationMode(_ enabled: Bool) {
    pdfView.isInMarkupMode = enabled
    if enabled, let canvas = overlayProvider.activeCanvas {
      canvas.becomeFirstResponder()
    } else {
      overlayProvider.resignCanvasResponders()
    }
  }

  func setDisplayMode(_ mode: String) {
    pdfView.displayMode = mode == "single" ? .singlePage : .singlePageContinuous
  }

  func setSelectedTool(_ name: String) {
    if name != "eraser" {
      lastInkToolName = name
    }
    overlayProvider.selectedToolName = name
    overlayProvider.applySelectedTool()
  }

  func setSelectedColor(_ hex: String) {
    overlayProvider.selectedColor = UIColor(hex: hex)
    overlayProvider.applySelectedTool()
  }

  func go(toPage pageNumber: Int) {
    guard let document = pdfView.document,
          let page = document.page(at: max(0, min(document.pageCount - 1, pageNumber - 1))) else { return }
    if currentPageIndex != pageNumber {
      pdfView.go(to: page)
    }
    emitCurrentPage()
  }

  func setZoomStep(_ step: Int) {
    let difference = step - overlayProvider.lastZoomStep
    guard difference != 0 else { return }
    overlayProvider.lastZoomStep = step
    let next = pdfView.scaleFactor * pow(1.12, CGFloat(difference))
    pdfView.scaleFactor = min(pdfView.maxScaleFactor, max(pdfView.minScaleFactor, next))
    emitZoom()
  }

  func undo(token: Int) {
    guard token != overlayProvider.undoToken else { return }
    overlayProvider.undoToken = token
    overlayProvider.activeCanvas?.undoManager?.undo()
  }

  func redo(token: Int) {
    guard token != overlayProvider.redoToken else { return }
    overlayProvider.redoToken = token
    overlayProvider.activeCanvas?.undoManager?.redo()
  }

  fileprivate func emitDrawingChanged(for canvas: PKCanvasView, scheduleSnapshot: Bool = true) {
    let pageIndex = overlayProvider.pageIndex(for: canvas) ?? currentPageIndex
    onDrawingChanged([
      "page": pageIndex,
      "strokeCount": canvas.drawing.strokes.count,
      "isEmpty": canvas.drawing.strokes.isEmpty,
      "canUndo": canvas.undoManager?.canUndo ?? false,
      "canRedo": canvas.undoManager?.canRedo ?? false,
    ])
    if scheduleSnapshot {
      self.scheduleSnapshot(for: canvas, pageIndex: pageIndex)
    }
  }

  fileprivate func emitExistingLocalSnapshot(forPageIndex pageIndex: Int) {
    guard pageIndex > 0, let payload = existingSnapshotPayload(forPageIndex: pageIndex) else { return }
    onLocalSnapshot(payload)
  }

  /// Restore can run while the React view is still attaching listeners; defer
  /// so stroke counts and retry uploads are not dropped.
  fileprivate func scheduleRestoreReport(strokeCount: Int, pageIndex: Int, canvas: PKCanvasView) {
    DispatchQueue.main.async { [weak self, weak canvas] in
      guard let self, let canvas else { return }
      self.onDrawingChanged([
        "page": pageIndex,
        "strokeCount": strokeCount,
        "isEmpty": strokeCount == 0,
        "canUndo": canvas.undoManager?.canUndo ?? false,
        "canRedo": canvas.undoManager?.canRedo ?? false,
      ])
      if strokeCount > 0 {
        self.emitExistingLocalSnapshot(forPageIndex: pageIndex)
      }
    }
  }

  private func existingSnapshotPayload(forPageIndex pageIndex: Int) -> [String: Any]? {
    let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("ConuoInk", isDirectory: true)
      .appendingPathComponent(snapshotNamespace, isDirectory: true)
    let drawingURL = base.appendingPathComponent("page-\(pageIndex).drawing")
    let previewURL = base.appendingPathComponent("page-\(pageIndex).png")
    guard let drawingData = try? Data(contentsOf: drawingURL),
          let previewData = try? Data(contentsOf: previewURL),
          !drawingData.isEmpty, !previewData.isEmpty else { return nil }
    return [
      "page": pageIndex,
      "drawingFileUri": drawingURL.absoluteString,
      "drawingBytes": drawingData.count,
      "drawingSha256": Self.sha256(drawingData),
      "previewFileUri": previewURL.absoluteString,
      "previewBytes": previewData.count,
      "previewSha256": Self.sha256(previewData),
      "coordinateSpace": ["version": 1, "space": "pdf-crop-box"],
    ]
  }

  private func scheduleSnapshot(for canvas: PKCanvasView, pageIndex: Int) {
    snapshotWorkItems[pageIndex]?.cancel()
    let item = DispatchWorkItem { [weak self, weak canvas] in
      guard let self, let canvas else { return }
      self.snapshot(canvas: canvas, pageIndex: pageIndex)
      self.snapshotWorkItems[pageIndex] = nil
    }
    snapshotWorkItems[pageIndex] = item
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.8, execute: item)
  }

  private func snapshot(canvas: PKCanvasView, pageIndex: Int) {
    let page = pageIndex
    guard page > 0 else { return }
    let drawingData = canvas.drawing.dataRepresentation()
    let renderSize = canvas.bounds.size == .zero ? canvas.drawing.bounds.size : canvas.bounds.size
    guard renderSize.width > 1, renderSize.height > 1 else { return }
    let preview = canvas.drawing.image(
      from: CGRect(origin: .zero, size: renderSize),
      scale: min(2, UIScreen.main.scale)
    )
    guard let previewData = preview.pngData() else { return }
    let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("ConuoInk", isDirectory: true)
      .appendingPathComponent(snapshotNamespace, isDirectory: true)
    let drawingURL = base.appendingPathComponent("page-\(page).drawing")
    let previewURL = base.appendingPathComponent("page-\(page).png")
    do {
      try FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
      let drawingTemp = drawingURL.appendingPathExtension("tmp")
      let previewTemp = previewURL.appendingPathExtension("tmp")
      try drawingData.write(to: drawingTemp, options: .atomic)
      try previewData.write(to: previewTemp, options: .atomic)
      try Self.replace(temp: drawingTemp, target: drawingURL)
      try Self.replace(temp: previewTemp, target: previewURL)
      onLocalSnapshot([
        "page": page,
        "drawingFileUri": drawingURL.absoluteString,
        "drawingBytes": drawingData.count,
        "drawingSha256": Self.sha256(drawingData),
        "previewFileUri": previewURL.absoluteString,
        "previewBytes": previewData.count,
        "previewSha256": Self.sha256(previewData),
        "coordinateSpace": ["version": 1, "space": "pdf-crop-box"],
      ])
    } catch {
      // Keep the page dirty in memory; do not claim local protection.
    }
  }

  fileprivate func loadDrawing(for page: PDFPage) -> PKDrawing? {
    let index = (pdfView.document?.index(for: page) ?? 0) + 1
    return loadDrawing(forPageIndex: index)
  }

  fileprivate func loadDrawing(forPageIndex index: Int) -> PKDrawing? {
    let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("ConuoInk", isDirectory: true)
      .appendingPathComponent(snapshotNamespace, isDirectory: true)
    let url = base.appendingPathComponent("page-\(index).drawing")
    guard let data = try? Data(contentsOf: url) else { return nil }
    return try? PKDrawing(data: data)
  }

  private static func replace(temp: URL, target: URL) throws {
    if FileManager.default.fileExists(atPath: target.path) {
      _ = try FileManager.default.replaceItemAt(target, withItemAt: temp)
    } else {
      try FileManager.default.moveItem(at: temp, to: target)
    }
  }

  private static func sha256(_ data: Data) -> String {
    SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
  }

  private static func safePathComponent(_ value: String) -> String {
    let allowed = CharacterSet.alphanumerics
    return String(value.unicodeScalars.map { scalar in
      allowed.contains(scalar) || scalar == "-" || scalar == "_" ? Character(scalar) : "_"
    }.prefix(80))
  }

  private var currentPageIndex: Int {
    guard let document = pdfView.document, let page = pdfView.currentPage else { return 0 }
    return document.index(for: page) + 1
  }

  private func emitCurrentPage() {
    guard let document = pdfView.document else { return }
    onPageChanged([
      "page": currentPageIndex,
      "pageCount": document.pageCount,
    ])
  }

  private func emitZoom() {
    onZoomChanged(["scaleFactor": Double(pdfView.scaleFactor)])
  }

  private func loadDocument(uri: String?) {
    let document: PDFDocument?
    if let uri, let url = URL(string: uri), url.isFileURL {
      document = PDFDocument(url: url)
    } else {
      document = Self.makeFixtureDocument()
    }

    guard let document, document.pageCount > 0 else {
      pdfView.document = nil
      return
    }

    pdfView.document = document
    if let firstPage = document.page(at: 0) {
      pdfView.go(to: firstPage)
    }
    emitCurrentPage()
  }

  /// Creates a three-page, non-sensitive PDF so WP0 can be exercised without
  /// checking a document into the app bundle or reading network content.
  private static func makeFixtureDocument() -> PDFDocument? {
    let pageRect = CGRect(x: 0, y: 0, width: 612, height: 792)
    let renderer = UIGraphicsPDFRenderer(bounds: pageRect)
    let data = renderer.pdfData { context in
      for pageNumber in 1...3 {
        context.beginPage()
        let title = "第二章 · 周期信号"
        let subtitle = "定义、性质与例题　·　\(pageNumber)"
        let section = "例 2.1　周期信号的表示"
        let equation = "x(t) = A · cos(ω₀t + φ)，　ω₀ = 2π / T₀"
        let note = "周期 T₀ 确定后，连续时间信号的基频由 ω₀ 决定。"
        (title as NSString).draw(
          at: CGPoint(x: 48, y: 56),
          withAttributes: [
            .font: UIFont.systemFont(ofSize: 22, weight: .semibold),
            .foregroundColor: UIColor.label,
          ]
        )
        (subtitle as NSString).draw(
          in: CGRect(x: 48, y: 94, width: 516, height: 24),
          withAttributes: [
            .font: UIFont.systemFont(ofSize: 13),
            .foregroundColor: UIColor.secondaryLabel,
          ]
        )
        (section as NSString).draw(
          at: CGPoint(x: 48, y: 158),
          withAttributes: [
            .font: UIFont.systemFont(ofSize: 15, weight: .semibold),
            .foregroundColor: UIColor.label,
          ]
        )
        (equation as NSString).draw(
          at: CGPoint(x: 48, y: 188),
          withAttributes: [
            .font: UIFont.systemFont(ofSize: 17),
            .foregroundColor: UIColor.label,
          ]
        )
        (note as NSString).draw(
          in: CGRect(x: 48, y: 220, width: 516, height: 36),
          withAttributes: [
            .font: UIFont.systemFont(ofSize: 12),
            .foregroundColor: UIColor.secondaryLabel,
          ]
        )
        UIColor(red: 0.345, green: 0.314, blue: 0.812, alpha: 1).setStroke()
        UIBezierPath(
          roundedRect: CGRect(x: 48, y: 284, width: 516, height: 360),
          cornerRadius: 18
        ).stroke()
      }
    }
    guard let document = PDFDocument(data: data) else { return nil }
    // Keep the probe useful for the WP0 rotation/CropBox check without
    // committing a binary fixture into the app bundle.
    if let rotatedPage = document.page(at: 1) {
      rotatedPage.rotation = 90
      let mediaBox = rotatedPage.bounds(for: .mediaBox)
      rotatedPage.setBounds(mediaBox.insetBy(dx: 36, dy: 36), for: .cropBox)
    }
    return document
  }
}

private final class ConuoPageOverlayProvider: NSObject, PDFPageOverlayViewProvider, PKCanvasViewDelegate {
  weak var owner: ConuoPdfInkView?
  var allowsFingerDrawing = false
  private var canvases = NSHashTable<PKCanvasView>.weakObjects()
  private var pageIndices: [ObjectIdentifier: Int] = [:]
  weak var activeCanvas: PKCanvasView?
  var snapshotNamespace = "default"
  var selectedToolName = "pen"
  var selectedColor = UIColor.black
  var lastZoomStep = 0
  var undoToken = 0
  var redoToken = 0

  init(owner: ConuoPdfInkView) {
    self.owner = owner
  }

  func pdfView(_ view: PDFView, overlayViewFor page: PDFPage) -> UIView? {
    let canvas = PKCanvasView(frame: .zero)
    canvas.backgroundColor = .clear
    canvas.isOpaque = false
    canvas.drawingPolicy = allowsFingerDrawing ? .anyInput : .pencilOnly
    canvas.delegate = self
    canvas.tool = makeSelectedTool()
    canvas.isScrollEnabled = false
    canvas.alwaysBounceVertical = false
    canvas.alwaysBounceHorizontal = false
    if let owner, let document = view.document {
      let pageIndex = document.index(for: page) + 1
      pageIndices[ObjectIdentifier(canvas)] = pageIndex
      canvas.drawing = owner.loadDrawing(for: page) ?? PKDrawing()
      owner.scheduleRestoreReport(
        strokeCount: canvas.drawing.strokes.count,
        pageIndex: pageIndex,
        canvas: canvas
      )
    }
    canvases.add(canvas)
    return canvas
  }

  func pdfView(_ pdfView: PDFView, willDisplayOverlayView overlayView: UIView, for page: PDFPage) {
    guard let canvas = overlayView as? PKCanvasView else { return }
    canvas.drawingPolicy = allowsFingerDrawing ? .anyInput : .pencilOnly
    activeCanvas = canvas
    canvas.tool = makeSelectedTool()
    if canvas.drawing.strokes.isEmpty, let owner {
      canvas.drawing = owner.loadDrawing(for: page) ?? PKDrawing()
    }
    if let owner {
      let pageIndex = pageIndices[ObjectIdentifier(canvas)] ?? 0
      owner.scheduleRestoreReport(
        strokeCount: canvas.drawing.strokes.count,
        pageIndex: pageIndex,
        canvas: canvas
      )
    }
    if pdfView.isInMarkupMode {
      canvas.becomeFirstResponder()
    }
  }

  func pdfView(_ pdfView: PDFView, willEndDisplayingOverlayView overlayView: UIView, for page: PDFPage) {
    if let canvas = overlayView as? PKCanvasView {
      pageIndices.removeValue(forKey: ObjectIdentifier(canvas))
    }
  }

  func canvasViewDrawingDidChange(_ canvasView: PKCanvasView) {
    owner?.emitDrawingChanged(for: canvasView)
  }

  func updateDrawingPolicies() {
    for canvas in canvases.allObjects {
      canvas.drawingPolicy = allowsFingerDrawing ? .anyInput : .pencilOnly
    }
  }

  func resignCanvasResponders() {
    canvases.allObjects.forEach { $0.resignFirstResponder() }
  }

  func pageIndex(for canvas: PKCanvasView) -> Int? {
    pageIndices[ObjectIdentifier(canvas)]
  }

  func restoreVisibleDrawings() {
    guard let owner else { return }
    for canvas in canvases.allObjects {
      guard canvas.drawing.strokes.isEmpty,
            let pageIndex = pageIndices[ObjectIdentifier(canvas)] else { continue }
      canvas.drawing = owner.loadDrawing(forPageIndex: pageIndex) ?? PKDrawing()
      owner.scheduleRestoreReport(
        strokeCount: canvas.drawing.strokes.count,
        pageIndex: pageIndex,
        canvas: canvas
      )
    }
  }

  func applySelectedTool() {
    canvases.allObjects.forEach { $0.tool = makeSelectedTool() }
  }

  private func makeSelectedTool() -> PKTool {
    switch selectedToolName {
    case "pencil":
      return PKInkingTool(.pencil, color: selectedColor, width: 2)
    case "highlighter":
      return PKInkingTool(.marker, color: selectedColor.withAlphaComponent(0.32), width: 9)
    case "eraser":
      return PKEraserTool(.vector)
    case "lasso":
      return PKLassoTool()
    default:
      return PKInkingTool(.pen, color: selectedColor, width: 2)
    }
  }
}

extension ConuoPdfInkView: UIPencilInteractionDelegate {
  func pencilInteractionDidTap(_ interaction: UIPencilInteraction) {
    let current = overlayProvider.selectedToolName
    let next: String
    if current == "eraser" {
      next = lastInkToolName == "eraser" ? "pen" : lastInkToolName
    } else {
      lastInkToolName = current
      next = "eraser"
    }
    setSelectedTool(next)
    onToolToggled(["tool": next])
  }
}

private extension UIColor {
  convenience init(hex: String) {
    let value = hex.trimmingCharacters(in: CharacterSet(charactersIn: "#"))
    var number: UInt64 = 0
    Scanner(string: value).scanHexInt64(&number)
    self.init(
      red: CGFloat((number >> 16) & 0xff) / 255,
      green: CGFloat((number >> 8) & 0xff) / 255,
      blue: CGFloat(number & 0xff) / 255,
      alpha: 1
    )
  }
}
