import { Button } from "@/components/ui/button.tsx";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select.tsx";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";

/**
 * Scaffold probe, not the board. It exists to prove the ARIA contracts the Playwright
 * suite already depends on survive the move to shadcn — a real <select> so
 * `getByRole("option")` resolves without opening anything, and a Sheet that reports as a
 * dialog. Replaced wholesale by the real board.
 */
export function App() {
  return (
    <main className="grid h-full place-items-center gap-6 bg-background p-8 text-foreground">
      <section aria-labelledby="probe-heading" className="grid gap-4">
        <h1 id="probe-heading" className="text-sm font-medium tracking-wide uppercase">
          scaffold probe
        </h1>

        <label className="grid gap-1 text-sm">
          Project
          <NativeSelect defaultValue="10x">
            <NativeSelectOption value="10x">10x</NativeSelectOption>
            <NativeSelectOption value="other">other</NativeSelectOption>
          </NativeSelect>
        </label>

        <Sheet>
          <SheetTrigger asChild>
            <Button>New ticket</Button>
          </SheetTrigger>
          <SheetContent side="right">
            <SheetHeader>
              <SheetTitle>New ticket</SheetTitle>
            </SheetHeader>
          </SheetContent>
        </Sheet>

        <p className="flex items-center gap-2 text-sm">
          <Spinner /> working
        </p>
      </section>
    </main>
  );
}
