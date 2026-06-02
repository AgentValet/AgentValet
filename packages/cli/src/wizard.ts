import prompts from "prompts";
import chalk from "chalk";

interface WizardInput {
  ownerId: string;
  agentName: string;
  description: string;
  scopes: string[];
}

export async function runWizard(prefilled: WizardInput): Promise<WizardInput> {
  console.log(chalk.bold("\nAgentValet — Register Agent\n"));

  const questions: prompts.PromptObject[] = [];

  if (!prefilled.ownerId) {
    questions.push({
      type: "text",
      name: "ownerId",
      message: "Owner ID (from https://app.agentvalet.ai/settings):",
      validate: (v: string) => (v.trim() ? true : "Owner ID is required"),
    });
  }

  if (!prefilled.agentName) {
    questions.push({
      type: "text",
      name: "agentName",
      message: "Agent name:",
      initial: "My Agent",
      validate: (v: string) => (v.trim() ? true : "Name is required"),
    });
  }

  questions.push(
    {
      type: "text",
      name: "description",
      message: "Description (optional):",
      initial: prefilled.description,
    },
    {
      type: "text",
      name: "scopesRaw",
      message: "Scopes (comma-separated, e.g. slack:chat:write,gmail:send):",
      initial: prefilled.scopes.join(","),
    }
  );

  const answers = await prompts(questions, {
    onCancel: () => {
      console.log(chalk.yellow("\nCancelled."));
      process.exit(0);
    },
  });

  const ownerId = (answers.ownerId as string | undefined) ?? prefilled.ownerId;
  const agentName = (answers.agentName as string | undefined) ?? prefilled.agentName;
  const description = (answers.description as string | undefined) ?? prefilled.description;
  const scopesRaw = answers.scopesRaw as string | undefined;
  const scopes =
    scopesRaw?.split(",").map((s) => s.trim()).filter(Boolean) ?? prefilled.scopes;

  return { ownerId: ownerId.trim(), agentName: agentName.trim(), description, scopes };
}
