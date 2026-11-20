const fs = require('node:fs/promises')
const path = require('node:path')

// Sharp is only needed to regenerate committed artwork, not to build or run the app.
// A shared installation can be selected with ICON_SHARP_MODULE=/path/to/sharp.
const sharp = require(process.env.ICON_SHARP_MODULE || 'sharp')
const root = path.resolve(__dirname, '..')
const icoSizes = [16, 20, 24, 32, 40, 48, 64, 128, 256]

function encodeIco(images) {
  const directory = Buffer.alloc(6 + 16 * images.length)
  directory.writeUInt16LE(1, 2)
  directory.writeUInt16LE(images.length, 4)
  let offset = directory.length
  images.forEach(({ size, png }, index) => {
    const start = 6 + 16 * index
    directory[start] = size === 256 ? 0 : size
    directory[start + 1] = size === 256 ? 0 : size
    directory.writeUInt16LE(1, start + 4)
    directory.writeUInt16LE(32, start + 6)
    directory.writeUInt32LE(png.length, start + 8)
    directory.writeUInt32LE(offset, start + 12)
    offset += png.length
  })
  return Buffer.concat([directory, ...images.map(({ png }) => png)])
}

async function main() {
  const master = await fs.readFile(path.join(root, 'src/assets/app-icon.svg'))
  const small = await fs.readFile(path.join(root, 'src/assets/app-icon-small.svg'))
  const icons = new Map()
  await fs.mkdir(path.join(root, 'build/icons'), { recursive: true })
  for (const size of [...icoSizes, 512, 1024]) {
    const png = await sharp(size <= 32 ? small : master, { density: 384 }).resize(size, size).png().toBuffer()
    icons.set(size, png)
    await fs.writeFile(path.join(root, `build/icons/app-icon-${size}.png`), png)
  }
  await fs.writeFile(path.join(root, 'build/app-icon.ico'), encodeIco(icoSizes.map((size) => ({ size, png: icons.get(size) }))))
  await fs.writeFile(path.join(root, 'build/app-icon.png'), icons.get(1024))
  await fs.writeFile(path.join(root, 'src/assets/app-icon.png'), icons.get(128))

  const positions = [{ size: 16, x: 456 }, { size: 20, x: 526 }, { size: 24, x: 596 }, { size: 32, x: 674 }, { size: 48, x: 764 }, { size: 64, x: 872 }]
  const board = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="600">
    <rect width="1024" height="600" fill="#0D121C"/>
    <text x="64" y="65" fill="#ECF3FB" font-family="Segoe UI,Arial,sans-serif" font-size="30" font-weight="600">Codex Usage Details</text>
    <text x="64" y="97" fill="#8F9FB4" font-family="Segoe UI,Arial,sans-serif" font-size="16">Application icon · native-size checks</text>
    <rect x="416" y="128" width="536" height="172" rx="16" fill="#192230"/>
    <rect x="416" y="324" width="536" height="172" rx="16" fill="#EAF0F7"/>
    <text x="440" y="160" fill="#A5B5CB" font-family="Segoe UI,Arial,sans-serif" font-size="12" letter-spacing="1.5">DARK SURFACE</text>
    <text x="440" y="356" fill="#506079" font-family="Segoe UI,Arial,sans-serif" font-size="12" letter-spacing="1.5">LIGHT SURFACE</text>
    <text x="64" y="506" fill="#A5B5CB" font-family="Segoe UI,Arial,sans-serif" font-size="14">Editable SVG · PNG · multi-resolution ICO</text>
    ${positions.map(({ size, x }) => `<text x="${x}" y="275" text-anchor="middle" fill="#A5B5CB" font-family="Segoe UI,Arial,sans-serif" font-size="12">${size}px</text><text x="${x}" y="471" text-anchor="middle" fill="#506079" font-family="Segoe UI,Arial,sans-serif" font-size="12">${size}px</text>`).join('')}
  </svg>`)
  const layers = [{ input: icons.get(256), left: 64, top: 174 }]
  for (const { size, x } of positions) {
    for (const y of [218, 414]) layers.push({ input: icons.get(size), left: x - size / 2, top: y - size / 2 })
  }
  await fs.mkdir(path.join(root, 'design'), { recursive: true })
  await sharp(board).composite(layers).png().toFile(path.join(root, 'design/app-icon-preview.png'))
  console.log(`Generated app-icon.ico (${icoSizes.join(', ')}px), PNG assets and design/app-icon-preview.png.`)
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
