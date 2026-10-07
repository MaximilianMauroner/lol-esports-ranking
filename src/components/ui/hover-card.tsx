import { PreviewCard as HoverCardPrimitive } from '@base-ui/react/preview-card'
import { cn } from '@/lib/utils'

function HoverCard(props: HoverCardPrimitive.Root.Props) {
  return <HoverCardPrimitive.Root {...props} />
}

function HoverCardTrigger(props: HoverCardPrimitive.Trigger.Props) {
  return <HoverCardPrimitive.Trigger data-slot="hover-card-trigger" {...props} />
}

function HoverCardContent({
  className,
  side = 'bottom',
  sideOffset = 8,
  align = 'center',
  alignOffset = 0,
  ...props
}: HoverCardPrimitive.Popup.Props & Pick<HoverCardPrimitive.Positioner.Props, 'side' | 'sideOffset' | 'align' | 'alignOffset'>) {
  return (
    <HoverCardPrimitive.Portal>
      <HoverCardPrimitive.Positioner side={side} sideOffset={sideOffset} align={align} alignOffset={alignOffset} className="isolate z-50">
        <HoverCardPrimitive.Popup
          data-slot="hover-card-content"
          className={cn('w-72 max-w-[calc(100vw-2rem)] rounded-md border border-[var(--line-strong)] bg-card p-4 text-sm text-foreground shadow-lg outline-none', className)}
          {...props}
        />
      </HoverCardPrimitive.Positioner>
    </HoverCardPrimitive.Portal>
  )
}

export { HoverCard, HoverCardTrigger, HoverCardContent }
