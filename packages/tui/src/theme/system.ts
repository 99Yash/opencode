import { RGBA, type TerminalColors } from "@opentui/core"
import { ansiToRgba, tint } from "./color"
import { HueStep, type Mode, type ThemeFile } from "./v2"

export function terminalMode(colors: TerminalColors): "dark" | "light" | undefined {
  const bg = colors.defaultBackground
  if (!bg) return
  const { r, g, b } = RGBA.fromHex(bg)
  return 0.299 * r + 0.587 * g + 0.114 * b > 0.5 ? "light" : "dark"
}

export function generateSystem(colors: TerminalColors, mode: "dark" | "light") {
  const value = resolveSystem(colors, mode)

  return {
    theme: {
      primary: value.ansi.cyan,
      secondary: value.ansi.magenta,
      accent: value.ansi.cyan,
      error: value.ansi.red,
      warning: value.ansi.yellow,
      success: value.ansi.green,
      info: value.ansi.cyan,
      text: value.fg,
      textMuted: value.textMuted,
      selectedListItemText: value.bg,
      background: value.transparent,
      backgroundPanel: value.grays[2],
      backgroundElement: value.grays[3],
      backgroundMenu: value.grays[3],
      borderSubtle: value.grays[6],
      border: value.grays[7],
      borderActive: value.grays[8],
      diffAdded: value.ansi.green,
      diffRemoved: value.ansi.red,
      diffContext: value.grays[7],
      diffHunkHeader: value.grays[7],
      diffHighlightAdded: value.ansi.greenBright,
      diffHighlightRemoved: value.ansi.redBright,
      diffAddedBg: value.diffAddedBg,
      diffRemovedBg: value.diffRemovedBg,
      diffContextBg: value.diffContextBg,
      diffLineNumber: value.textMuted,
      diffAddedLineNumberBg: value.diffAddedLineNumberBg,
      diffRemovedLineNumberBg: value.diffRemovedLineNumberBg,
      markdownText: value.fg,
      markdownHeading: value.fg,
      markdownLink: value.ansi.blue,
      markdownLinkText: value.ansi.cyan,
      markdownCode: value.ansi.green,
      markdownBlockQuote: value.ansi.yellow,
      markdownEmph: value.ansi.yellow,
      markdownStrong: value.fg,
      markdownHorizontalRule: value.grays[7],
      markdownListItem: value.ansi.blue,
      markdownListEnumeration: value.ansi.cyan,
      markdownImage: value.ansi.blue,
      markdownImageText: value.ansi.cyan,
      markdownCodeBlock: value.fg,
      syntaxComment: value.textMuted,
      syntaxKeyword: value.ansi.magenta,
      syntaxFunction: value.ansi.blue,
      syntaxVariable: value.fg,
      syntaxString: value.ansi.green,
      syntaxNumber: value.ansi.yellow,
      syntaxType: value.ansi.cyan,
      syntaxOperator: value.ansi.cyan,
      syntaxPunctuation: value.fg,
    },
  }
}

export function generateSystemV2(colors: TerminalColors): ThemeFile {
  return {
    version: 2,
    light: generateSystemMode(colors, "light"),
    dark: generateSystemMode(colors, "dark"),
  }
}

function generateSystemMode(colors: TerminalColors, mode: Mode): ThemeFile["light"] {
  const value = resolveSystem(colors, mode)
  const scale = (color: RGBA) =>
    Object.fromEntries(HueStep.literals.map((step) => [step, hex(color)])) as Record<HueStep, string>

  return {
    hue: {
      gray: neutralScale(value, mode),
      red: scale(value.ansi.red),
      orange: scale(value.ansi.yellow),
      yellow: scale(value.ansi.yellow),
      green: scale(value.ansi.green),
      cyan: scale(value.ansi.cyan),
      blue: scale(value.ansi.blue),
      purple: scale(value.ansi.magenta),
      accent: scale(value.ansi.cyan),
      interactive: scale(value.ansi.cyan),
      neutral: "$hue.gray",
    },
  }
}

function resolveSystem(colors: TerminalColors, mode: Mode) {
  const bg = RGBA.fromHex(colors.defaultBackground ?? colors.palette[0]!)
  const fg = RGBA.fromHex(colors.defaultForeground ?? colors.palette[7]!)
  const transparent = RGBA.fromValues(bg.r, bg.g, bg.b, 0)
  const isDark = mode === "dark"

  const col = (index: number) => {
    const value = colors.palette[index]
    if (value) return RGBA.fromHex(value)
    return ansiToRgba(index)
  }

  const grays = generateGrayScale(bg, isDark)
  const textMuted = generateMutedTextColor(bg, isDark)
  const ansi = {
    red: col(1),
    green: col(2),
    yellow: col(3),
    blue: col(4),
    magenta: col(5),
    cyan: col(6),
    redBright: col(9),
    greenBright: col(10),
  }

  const diffAlpha = isDark ? 0.22 : 0.14
  const diffAddedBg = tint(bg, ansi.green, diffAlpha)
  const diffRemovedBg = tint(bg, ansi.red, diffAlpha)
  const diffContextBg = grays[2]
  const diffAddedLineNumberBg = tint(diffContextBg, ansi.green, diffAlpha)
  const diffRemovedLineNumberBg = tint(diffContextBg, ansi.red, diffAlpha)

  return {
    bg,
    fg,
    transparent,
    grays,
    textMuted,
    ansi,
    diffAddedBg,
    diffRemovedBg,
    diffContextBg,
    diffAddedLineNumberBg,
    diffRemovedLineNumberBg,
  }
}

function generateGrayScale(bg: RGBA, isDark: boolean): Record<number, RGBA> {
  const grays: Record<number, RGBA> = {}
  const bgR = bg.r * 255
  const bgG = bg.g * 255
  const bgB = bg.b * 255
  const luminance = 0.299 * bgR + 0.587 * bgG + 0.114 * bgB

  for (let i = 1; i <= 12; i++) {
    const factor = i / 12

    if (isDark && luminance < 10) {
      const gray = Math.floor(factor * 0.4 * 255)
      grays[i] = RGBA.fromInts(gray, gray, gray)
      continue
    }

    if (!isDark && luminance > 245) {
      const gray = Math.floor(255 - factor * 0.4 * 255)
      grays[i] = RGBA.fromInts(gray, gray, gray)
      continue
    }

    const next = isDark ? luminance + (255 - luminance) * factor * 0.4 : luminance * (1 - factor * 0.4)
    const ratio = next / luminance
    grays[i] = RGBA.fromInts(
      Math.floor(Math.min(Math.max(bgR * ratio, 0), 255)),
      Math.floor(Math.min(Math.max(bgG * ratio, 0), 255)),
      Math.floor(Math.min(Math.max(bgB * ratio, 0), 255)),
    )
  }

  return grays
}

function generateMutedTextColor(bg: RGBA, isDark: boolean): RGBA {
  const luminance = 0.299 * bg.r * 255 + 0.587 * bg.g * 255 + 0.114 * bg.b * 255
  if (isDark) {
    const gray = luminance < 10 ? 180 : Math.min(Math.floor(160 + luminance * 0.3), 200)
    return RGBA.fromInts(gray, gray, gray)
  }

  const gray = luminance > 245 ? 75 : Math.max(Math.floor(100 - (255 - luminance) * 0.2), 60)
  return RGBA.fromInts(gray, gray, gray)
}

function neutralScale(value: ReturnType<typeof resolveSystem>, mode: Mode) {
  const light: { step: HueStep; color: RGBA }[] = [
    { step: 100, color: value.transparent },
    { step: 200, color: value.grays[2] },
    { step: 300, color: value.grays[3] },
    { step: 700, color: value.textMuted },
    { step: 900, color: value.fg },
  ]
  const anchors =
    mode === "light"
      ? light
      : light.toReversed().map((source) => ({ ...source, step: (1000 - source.step) as HueStep }))
  return Object.fromEntries(
    HueStep.literals.map((step) => {
      const exact = anchors.find((anchor) => anchor.step === step)
      if (exact) return [step, hex(exact.color)]
      const lower = anchors.filter((anchor) => anchor.step < step).at(-1)!
      const upper = anchors.find((anchor) => anchor.step > step)!
      return [step, interpolate(lower.color, upper.color, (step - lower.step) / (upper.step - lower.step))]
    }),
  ) as Record<HueStep, string>
}

function interpolate(first: RGBA, second: RGBA, amount: number) {
  const start = first.toInts()
  const end = second.toInts()
  return `#${start.map((value, index) => byte(Math.round(value + (end[index]! - value) * amount))).join("")}`
}

function hex(color: RGBA) {
  const [red, green, blue, alpha] = color.toInts()
  return `#${byte(red)}${byte(green)}${byte(blue)}${alpha === 255 ? "" : byte(alpha)}`
}

function byte(value: number) {
  return value.toString(16).padStart(2, "0")
}
