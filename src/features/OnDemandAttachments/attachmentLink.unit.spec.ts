import { describe, expect, it } from "vitest";
import { DeferredAttachmentLinks } from "./attachmentLink";

describe("deferred attachment links", () => {
    it("resolves exact, encoded, parent-relative, and unique basename links", () => {
        const links = new DeferredAttachmentLinks(["Archive/image 1.png", "Archive/pdf/report.pdf"]);
        expect(links.resolve("Archive/image%201.png|300", "Notes/example.md")).toBe("Archive/image 1.png");
        expect(links.resolve("../Archive/image%201.png", "Notes/example.md")).toBe("Archive/image 1.png");
        expect(links.resolve("report.pdf#page=2", "Notes/example.md")).toBe("Archive/pdf/report.pdf");
    });
    it("never guesses between basename or direct/relative collisions", () => {
        const links = new DeferredAttachmentLinks(["one/a.png", "two/a.png", "a.png", "Notes/a.png"]);
        expect(links.resolve("a.png", "Notes/example.md")).toBeNull();
        expect(links.resolve("a.png", "Notes/example.md", true)).toBe("a.png");
        links.remove("a.png");
        links.remove("Notes/a.png");
        expect(links.resolve("a.png", "Notes/example.md")).toBeNull();
        links.remove("two/a.png");
        expect(links.resolve("a.png", "Notes/example.md")).toBe("one/a.png");
        links.add("two/a.png");
        expect(links.resolve("two/a.png", "Notes/example.md")).toBe("two/a.png");
    });
    it.each([
        "https://example.test/a.png",
        "app://vault/a.png",
        "/one/a.png",
        "../../one/a.png",
        "%00a.png",
        "%ZZ",
        ".obsidian/a.png",
        "one\\a.png",
    ])("rejects unsafe or unrelated target %s", (target) => {
        const links = new DeferredAttachmentLinks(["one/a.png"]);
        expect(links.resolve(target, "example.md")).toBeNull();
    });
});
