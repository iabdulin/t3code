import type { ProjectFaviconProject } from "../ProjectFavicon";
import { deriveProjectIdentity } from "../../projectIdentity";
import { projectIconColorClassName } from "../../projectIconColors";
import { cn } from "~/lib/utils";

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * Text colour class that identifies a project: the colour of its monogram or
 * lucide icon override, else the colour its monogram fallback derives from the
 * title. Returns null without a project.
 */
export function projectTextColorClassName(
  project: Pick<ProjectFaviconProject, "title" | "projectIcon"> | null,
): string | null {
  if (project === null) return null;
  const icon = project.projectIcon;
  return projectIconColorClassName(
    icon && icon.kind !== "emoji" ? icon.color : deriveProjectIdentity(project.title).color,
  );
}

/**
 * Renders a thread title with its first grapheme bold, three sizes up and in the
 * project's colour. Inline, so the parent's truncation and baseline still apply.
 */
export function ThreadTitleInitial(props: {
  title: string;
  project: Pick<ProjectFaviconProject, "title" | "projectIcon"> | null;
}) {
  const initial = graphemeSegmenter.segment(props.title)[Symbol.iterator]().next().value?.segment;
  if (initial === undefined) return null;
  return (
    <>
      <span className={cn("text-xl/0 font-bold", projectTextColorClassName(props.project))}>
        {initial}
      </span>
      {props.title.slice(initial.length)}
    </>
  );
}
