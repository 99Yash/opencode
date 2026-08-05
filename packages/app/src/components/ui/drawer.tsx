/**
 * Taken from https://www.solid-ui.com/docs/components/drawer
 * Only used in one place hence not a v2 component yet... can be promoted to ui/v2 later
 */

import type { JSX, ValidComponent } from "solid-js"
import { splitProps } from "solid-js"
import type { ContentProps, DynamicProps, OverlayProps } from "@corvu/drawer"
import DrawerPrimitive from "@corvu/drawer"

const Drawer = DrawerPrimitive

const DrawerPortal = DrawerPrimitive.Portal

const DrawerClose = DrawerPrimitive.Close

type DrawerOverlayProps<T extends ValidComponent = "div"> = OverlayProps<T> & { class?: string }

const DrawerOverlay = <T extends ValidComponent = "div">(props: DynamicProps<T, DrawerOverlayProps<T>>) => {
  const [, rest] = splitProps(props as DrawerOverlayProps, ["class"])
  const drawerContext = DrawerPrimitive.useContext()
  const overlayStyle = () => {
    const state = drawerContext.transitionState()
    if (state === "opening" || state === "closing") return undefined
    const open = drawerContext.openPercentage()
    return {
      opacity: open,
      "backdrop-filter": `blur(${4 * open}px)`,
    }
  }
  return (
    <DrawerPrimitive.Overlay
      class={props.class}
      classList={{
        "fixed inset-0 z-[100] bg-v2-overlay-simple-overlay-scrim opacity-0 backdrop-blur-none transition-[opacity,backdrop-filter] duration-300 data-[opening]:opacity-100 data-[opening]:backdrop-blur-[4px] data-[closing]:opacity-0 data-[closing]:backdrop-blur-none": true,
      }}
      style={overlayStyle()}
      {...rest}
    />
  )
}

type DrawerContentProps<T extends ValidComponent = "div"> = ContentProps<T> & {
  class?: string
  children?: JSX.Element
}

const DrawerContent = <T extends ValidComponent = "div">(props: DynamicProps<T, DrawerContentProps<T>>) => {
  const [, rest] = splitProps(props as DrawerContentProps, ["class", "children"])
  return (
    <DrawerPortal>
      <DrawerOverlay />
      <DrawerPrimitive.Content
        class={props.class}
        classList={{
          "group/drawer-content fixed inset-y-[6px] right-[6px] left-auto z-[100] flex h-auto max-h-[calc(100vh-12px)] w-[560px] max-w-[calc(100vw-12px)] flex-col items-start rounded-[8px] bg-v2-background-bg-base p-0 shadow-[var(--v2-elevation-overlay)] data-[transitioning]:transition-transform data-[transitioning]:duration-300 md:select-none": true,
        }}
        {...rest}
      >
        {props.children}
      </DrawerPrimitive.Content>
    </DrawerPortal>
  )
}

export {
  Drawer,
  DrawerPortal,
  DrawerOverlay,
  DrawerClose,
  DrawerContent,
}
