import Link from "next/link";
import { Container } from "@/components/container";
import { Button } from "@/components/button";

export default function NotFound() {
  return (
    <section className="flex min-h-[70vh] items-center bg-paper">
      <Container className="py-24 text-center">
        <p className="font-mono text-xs uppercase tracking-[0.22em] text-earth-600">Error 404</p>
        <h1 className="mt-4 font-display text-4xl font-semibold tracking-tight text-ink sm:text-5xl">
          This parcel doesn't exist.
        </h1>
        <p className="mx-auto mt-4 max-w-md text-[15px] leading-relaxed text-ink-mute">
          The page you're looking for isn't on the record. Let's get you back to solid ground.
        </p>
        <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <Button href="/" size="lg">Back to the homepage</Button>
          <Link
            href="/platform"
            className="text-[15px] font-medium text-forest-700 underline decoration-forest-300 underline-offset-4 hover:text-forest-800"
          >
            Explore the platform
          </Link>
        </div>
      </Container>
    </section>
  );
}
