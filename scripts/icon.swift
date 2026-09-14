import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

// Renders the unshipped mark: a ring left open at the top-left, with the lamp dot inside.
// The mark: a paper boat — a hull and a sail, folded out of two shapes.
// Kept to two solid forms with a gap between them so it survives being
// flattened to one colour at menu bar size.
func drawMark(_ ctx: CGContext, box: CGRect, ring: CGColor, dot: CGColor) {
    let s = box.width, x0 = box.minX, y0 = box.minY
    func p(_ x: Double, _ y: Double) -> CGPoint {
        CGPoint(x: x0 + CGFloat(x / 64.0) * s, y: y0 + s - CGFloat(y / 64.0) * s)
    }

    ctx.setFillColor(dot)
    let sail = CGMutablePath()
    sail.move(to: p(33, 4)); sail.addLine(to: p(33, 34)); sail.addLine(to: p(54, 34))
    sail.closeSubpath()
    ctx.addPath(sail); ctx.fillPath()

    ctx.setFillColor(ring)
    let hull = CGMutablePath()
    hull.move(to: p(6, 38)); hull.addLine(to: p(58, 38))
    hull.addLine(to: p(46, 56)); hull.addLine(to: p(18, 56))
    hull.closeSubpath()
    ctx.addPath(hull); ctx.fillPath()
}

func write(_ ctx: CGContext, _ path: String) {
    guard let image = ctx.makeImage(),
          let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: path) as CFURL,
                                                     UTType.png.identifier as CFString, 1, nil)
    else { fatalError("cannot write \(path)") }
    CGImageDestinationAddImage(dest, image, nil)
    CGImageDestinationFinalize(dest)
}

func context(_ size: Int) -> CGContext {
    let cs = CGColorSpaceCreateDeviceRGB()
    guard let ctx = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8,
                              bytesPerRow: 0, space: cs,
                              bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
    else { fatalError("no context") }
    return ctx
}

func rgb(_ hex: UInt32, _ a: CGFloat = 1) -> CGColor {
    CGColor(red: CGFloat((hex >> 16) & 0xff) / 255, green: CGFloat((hex >> 8) & 0xff) / 255,
            blue: CGFloat(hex & 0xff) / 255, alpha: a)
}

let args = CommandLine.arguments
let mode = args[1], size = Int(args[2])!, out = args[3]
let ctx = context(size)
let S = CGFloat(size)

if mode == "app" {
    // macOS leaves the canvas alone, so the tile is ours to draw: 82% body, Big Sur radius.
    let inset = S * 0.09
    let body = CGRect(x: inset, y: inset, width: S - inset * 2, height: S - inset * 2)
    let tile = CGPath(roundedRect: body, cornerWidth: body.width * 0.225,
                      cornerHeight: body.width * 0.225, transform: nil)
    ctx.addPath(tile)
    ctx.setFillColor(rgb(0x171d26))
    ctx.fillPath()
    let markSide = body.width * 0.62
    drawMark(ctx, box: CGRect(x: body.midX - markSide / 2, y: body.midY - markSide / 2,
                              width: markSide, height: markSide),
             ring: rgb(0xf0a63c), dot: rgb(0xff7a45))
} else {
    // Menu bar template: one flat colour plus alpha, macOS tints it per appearance.
    let pad = S * 0.08
    drawMark(ctx, box: CGRect(x: pad, y: pad, width: S - pad * 2, height: S - pad * 2),
             ring: rgb(0x000000), dot: rgb(0x000000))
}
write(ctx, out)
print("wrote \(out) (\(size)px, \(mode))")
