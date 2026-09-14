import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

// Renders the unshipped mark: a ring left open at the top-left, with the lamp dot inside.
// The mark: a ring left open at the top-left, with the lamp dot sitting in the gap.
// The dot stays out of the centre — a dot inside a ring is the screen-recording indicator.
func drawMark(_ ctx: CGContext, box: CGRect, ring: CGColor, dot: CGColor) {
    let m = box.width
    let cx = box.midX, cy = box.midY
    let r = 23.0 / 64.0 * m
    let w = 7.0 / 64.0 * m

    ctx.setStrokeColor(ring)
    ctx.setLineWidth(w)
    ctx.setLineCap(.round)
    ctx.beginPath()
    ctx.addArc(center: CGPoint(x: cx, y: cy), radius: r,
               startAngle: .pi / 2, endAngle: .pi / 2 - (300.0 * .pi / 180.0),
               clockwise: true)
    ctx.strokePath()

    let a = 127.5 * Double.pi / 180.0
    let d = 5.6 / 64.0 * m
    ctx.setFillColor(dot)
    ctx.fillEllipse(in: CGRect(x: cx + CGFloat(cos(a)) * r - d, y: cy + CGFloat(sin(a)) * r - d,
                               width: d * 2, height: d * 2))
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
