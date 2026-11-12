import { describe, expect, it } from "vite-plus/test";
import { deriveProjectIdentity } from "../../projectIdentity";
import { projectIconColorClassName } from "../../projectIconColors";
import { projectTextColorClassName } from "./ThreadTitleInitial";

describe("projectTextColorClassName", () => {
  it("uses the icon override colour, else the monogram colour derived from the title", () => {
    expect(
      projectTextColorClassName({
        title: "t3code",
        projectIcon: { kind: "monogram", text: "T3", color: "rose" },
      }),
    ).toBe(projectIconColorClassName("rose"));
    expect(
      projectTextColorClassName({
        title: "t3code",
        projectIcon: { kind: "lucide", name: "code", color: "teal" },
      }),
    ).toBe(projectIconColorClassName("teal"));
    expect(
      projectTextColorClassName({
        title: "t3code",
        projectIcon: { kind: "emoji", emoji: "🚀" },
      }),
    ).toBe(projectIconColorClassName(deriveProjectIdentity("t3code").color));
    expect(projectTextColorClassName({ title: "t3code", projectIcon: null })).toBe(
      projectIconColorClassName(deriveProjectIdentity("t3code").color),
    );
    expect(projectTextColorClassName(null)).toBeNull();
  });

  it("gives the same project the same colour and spreads different projects", () => {
    const colours = ["t3code", "swingmatch", "sfdp", "dotfiles", "website"].map((title) =>
      projectTextColorClassName({ title, projectIcon: null }),
    );
    expect(projectTextColorClassName({ title: "t3code", projectIcon: null })).toBe(colours[0]);
    expect(new Set(colours).size).toBeGreaterThan(1);
  });
});
