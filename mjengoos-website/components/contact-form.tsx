"use client";

import { useState } from "react";
import { Loader2, CheckCircle2, AlertTriangle, RotateCcw, Send } from "lucide-react";
import { ActionButton } from "@/components/button";
import { track } from "@/lib/analytics";
import { cn } from "@/lib/utils";

/**
 * Contact / early-access form (§45). Full states: idle → submitting →
 * success | error (with retry). Client-side validation mirrors the server
 * rules; the server is the authority.
 */

interface Config {
  source: "contact" | "signup";
  projectTypes?: string[];
  roles?: string[];
  countries?: string[];
  submitLabel: string;
  successTitle: string;
  successText: string;
  analyticsEvent: "contact_submitted" | "signup_completed" | "demo_requested";
}

const inputBase =
  "h-11 w-full rounded-md border bg-white px-3.5 text-[15px] text-ink placeholder:text-ink-faint focus:border-forest-500 focus:outline-none focus:ring-2 focus:ring-forest-500/20 transition-shadow";

const DEFAULT_PROJECT_TYPES = ["Residential house", "Apartments", "Commercial building", "Institutional", "Infrastructure", "Other"];
const DEFAULT_ROLES = ["Client / property owner", "Contractor", "Site supervisor", "Architect / Engineer / QS", "Surveyor", "Supplier", "Finance team", "Other"];
const DEFAULT_COUNTRIES = ["Kenya", "Tanzania", "Uganda", "Rwanda", "Nigeria", "Ghana", "South Africa", "Diaspora (US/EU/UK/UAE)", "Other"];

export function ContactForm({ config }: { config: Config }) {
  const [status, setStatus] = useState<"idle" | "submitting" | "success" | "error">("idle");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const fd = new FormData(form);
    const payload: Record<string, unknown> = { source: config.source };
    fd.forEach((v, k) => { payload[k] = v; });

    setStatus("submitting");
    setFieldErrors({});
    setFormError(null);

    try {
      // basePath-aware: the site may be served under /website (proxied by the
      // web app) — plain "/api/contact" would hit the app's 404 there.
      const res = await fetch(`${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/api/contact`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = (await res.json()) as { ok: boolean; errors?: Record<string, string>; error?: string };
      if (res.ok && json.ok) {
        setStatus("success");
        track(config.analyticsEvent, { source: config.source });
        form.reset();
        return;
      }
      if (json.errors) setFieldErrors(json.errors);
      setFormError(json.error ?? "Please check the highlighted fields and try again.");
      setStatus("error");
    } catch {
      setFormError("Network problem — check your connection and try again.");
      setStatus("error");
    }
  }

  if (status === "success") {
    return (
      <div className="rounded-xl border border-verified/25 bg-verified-soft p-8 text-center" role="status">
        <CheckCircle2 className="mx-auto h-10 w-10 text-verified" aria-hidden />
        <h3 className="mt-4 font-display text-xl font-semibold text-ink">{config.successTitle}</h3>
        <p className="mx-auto mt-2 max-w-sm text-[15px] leading-relaxed text-ink-mute">{config.successText}</p>
        <ActionButton
          variant="ghost"
          size="sm"
          className="mt-6"
          onClick={() => { setStatus("idle"); setRetryCount(0); }}
        >
          Send another
        </ActionButton>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} noValidate className="grid gap-5">
      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Name" htmlFor="cf-name" error={fieldErrors.name}>
          <input id="cf-name" name="name" type="text" required autoComplete="name" placeholder="Amina Wanjiru" className={inputBase} aria-invalid={Boolean(fieldErrors.name)} />
        </Field>
        <Field label="Email" htmlFor="cf-email" error={fieldErrors.email}>
          <input id="cf-email" name="email" type="email" required autoComplete="email" placeholder="you@example.com" className={inputBase} aria-invalid={Boolean(fieldErrors.email)} />
        </Field>
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Phone (optional)" htmlFor="cf-phone" error={fieldErrors.phone}>
          <input id="cf-phone" name="phone" type="tel" autoComplete="tel" placeholder="+254 7…" className={inputBase} />
        </Field>
        <Field label="Organization (optional)" htmlFor="cf-org">
          <input id="cf-org" name="organization" type="text" autoComplete="organization" placeholder="Company or practice" className={inputBase} />
        </Field>
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Role" htmlFor="cf-role" error={fieldErrors.role}>
          <select id="cf-role" name="role" className={cn(inputBase, "appearance-none bg-[url('data:image/svg+xml;charset=utf-8,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2212%22 height=%2212%22 viewBox=%220 0 12 12%22%3E%3Cpath d=%22M2 4l4 4 4-4%22 fill=%22none%22 stroke=%22%236B706D%22 stroke-width=%221.5%22/%3E%3C/svg%3E')] bg-[position:right_0.9rem_center] bg-no-repeat pr-9")} defaultValue="">
            <option value="" disabled>Choose your role</option>
            {(config.roles ?? DEFAULT_ROLES).map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </Field>
        <Field label={config.source === "signup" ? "Country" : "Country (optional)"} htmlFor="cf-country">
          <select id="cf-country" name="country" className={cn(inputBase, "appearance-none pr-9")} defaultValue="Kenya">
            {(config.countries ?? DEFAULT_COUNTRIES).map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </Field>
      </div>

      <Field label="Project type (optional)" htmlFor="cf-ptype">
        <select id="cf-ptype" name="projectType" className={cn(inputBase, "appearance-none pr-9")} defaultValue="">
          <option value="">Choose a project type</option>
          {(config.projectTypes ?? DEFAULT_PROJECT_TYPES).map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
      </Field>

      <Field
        label={config.source === "signup" ? "Anything we should know? (optional)" : "Message"}
        htmlFor="cf-message"
        error={fieldErrors.message}
      >
        <textarea
          id="cf-message"
          name="message"
          rows={4}
          maxLength={2000}
          required={config.source !== "signup"}
          placeholder={config.source === "signup" ? "Site location, timing, team size…" : "Tell us about your project — location, stage, what you're trying to solve…"}
          className={cn(inputBase, "h-auto min-h-24 py-3")}
          aria-invalid={Boolean(fieldErrors.message)}
        />
      </Field>

      {formError && (
        <p className="flex items-start gap-2 rounded-md border border-alert/25 bg-alert-soft px-4 py-3 text-[13.5px] text-alert" role="alert">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          {formError}
          {retryCount > 0 && " (retry " + retryCount + ")"}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-4">
        <ActionButton type="submit" disabled={status === "submitting"} className="min-w-40">
          {status === "submitting" ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Sending…
            </>
          ) : status === "error" ? (
            <>
              <RotateCcw className="h-4 w-4" aria-hidden /> Try again
            </>
          ) : (
            <>
              <Send className="h-4 w-4" aria-hidden /> {config.submitLabel}
            </>
          )}
        </ActionButton>
        {status === "error" && (
          <button
            type="button"
            className="text-sm font-medium text-ink-mute underline decoration-ink/30 underline-offset-4 hover:text-ink"
            onClick={() => { setStatus("idle"); setFormError(null); setFieldErrors({}); setRetryCount((n) => n + 1); }}
          >
            Clear the form
          </button>
        )}
        <p className="text-[12px] text-ink-mute">
          We reply within two working days. No mailing lists.
        </p>
      </div>
    </form>
  );
}

function Field({
  label,
  htmlFor,
  error,
  children,
}: {
  label: string;
  htmlFor: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label htmlFor={htmlFor} className="mb-1.5 block text-[13px] font-semibold text-ink-soft">
        {label}
      </label>
      {children}
      {error && (
        <p className="mt-1.5 text-[12.5px] text-alert" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
