import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { WelcomeCard } from "./welcome-card";

describe("WelcomeCard", () => {
  it("renders the project name", () => {
    render(<WelcomeCard projectName="acme" />);
    expect(screen.getByRole("heading", { name: "acme" })).toBeInTheDocument();
  });

  it("renders the learn more action", () => {
    render(<WelcomeCard projectName="acme" />);
    expect(screen.getByRole("button", { name: "Learn more" })).toBeInTheDocument();
  });
});
