import type { Locale } from "~/lib/language"
import { dict as en } from "~/i18n/en"
import { dict as zh } from "~/i18n/zh"
import { dict as zht } from "~/i18n/zht"
import { dict as ko } from "~/i18n/ko"
import { dict as de } from "~/i18n/de"
import { dict as es } from "~/i18n/es"
import { dict as fr } from "~/i18n/fr"
import { dict as it } from "~/i18n/it"
import { dict as da } from "~/i18n/da"
import { dict as ja } from "~/i18n/ja"
import { dict as pl } from "~/i18n/pl"
import { dict as ru } from "~/i18n/ru"
import { dict as uk } from "~/i18n/uk"
import { dict as ar } from "~/i18n/ar"
import { dict as no } from "~/i18n/no"
import { dict as br } from "~/i18n/br"
import { dict as th } from "~/i18n/th"
import { dict as tr } from "~/i18n/tr"

export type Key = keyof typeof en
export type Dict = Record<Key, string>

const base = en satisfies Dict

const goFallback = {
  "go.pricing.body": base["go.pricing.body"],
  "go.how.body": base["go.how.body"],
  "go.how.step1.title": base["go.how.step1.title"],
  "go.how.step1.beforeLink": base["go.how.step1.beforeLink"],
  "go.how.step1.link": base["go.how.step1.link"],
  "go.how.step2.title": base["go.how.step2.title"],
  "go.how.step2.link": base["go.how.step2.link"],
  "go.how.step2.afterLink": base["go.how.step2.afterLink"],
  "go.how.step3.title": base["go.how.step3.title"],
  "go.how.step3.body": base["go.how.step3.body"],
  "go.faq.q8": base["go.faq.q8"],
  "go.faq.a8": base["go.faq.a8"],
}

function withGoFallback(dict: Dict): Dict {
  return { ...dict, ...goFallback }
}

export function i18n(locale: Locale): Dict {
  if (locale === "en") return base
  if (locale === "zh") return withGoFallback({ ...base, ...zh })
  if (locale === "zht") return withGoFallback({ ...base, ...zht })
  if (locale === "ko") return withGoFallback({ ...base, ...ko })
  if (locale === "de") return withGoFallback({ ...base, ...de })
  if (locale === "es") return withGoFallback({ ...base, ...es })
  if (locale === "fr") return withGoFallback({ ...base, ...fr })
  if (locale === "it") return withGoFallback({ ...base, ...it })
  if (locale === "da") return withGoFallback({ ...base, ...da })
  if (locale === "ja") return withGoFallback({ ...base, ...ja })
  if (locale === "pl") return withGoFallback({ ...base, ...pl })
  if (locale === "ru") return withGoFallback({ ...base, ...ru })
  if (locale === "uk") return withGoFallback({ ...base, ...uk })
  if (locale === "ar") return withGoFallback({ ...base, ...ar })
  if (locale === "no") return withGoFallback({ ...base, ...no })
  if (locale === "br") return withGoFallback({ ...base, ...br })
  if (locale === "th") return withGoFallback({ ...base, ...th })
  return withGoFallback({ ...base, ...tr })
}
