"""Use case: a LangChain agent whose tools are governed.

The usual LangChain setup puts a Slack token and a GitHub token in
os.environ, hands them to tools, and hopes the LLM behaves. If the model is
talked into something destructive, nothing is standing in the way.

Here the tools call through AgentValet instead. The LLM can attempt anything;
what it is *allowed* to do is decided outside the model, by the owner's grants
and policy. Destructive scopes pause for a human. Every attempt is audited,
including the ones that get refused.

    pip install agentvalet langchain-core langchain-openai
    agentvalet register --code <invite-or-enrollment-code>
"""

from langchain_core.tools import tool

from agentvalet import (
    AgentValet,
    AccessDeniedError,
    ApprovalDeniedError,
    ApprovalTimeoutError,
)

av = AgentValet.from_env()


@tool
def post_to_slack(channel: str, text: str) -> str:
    """Post a message to a Slack channel. Use for team notifications."""
    try:
        av.call(
            platform="slack",
            endpoint="/api/chat.postMessage",
            method="POST",
            scope="chat:write",
            data={"channel": channel, "text": text},
            # The reason reaches the approver's screen. Give the human enough
            # to decide without having to come and ask you.
            reason=f"Agent posting to {channel}",
        )
        return f"Posted to {channel}."
    except AccessDeniedError:
        # Return the refusal as a STRING, don't raise. The agent can then
        # reason about it ("I'm not allowed to post there, I'll report back")
        # instead of the whole run blowing up.
        return f"Not permitted to post to {channel}. No grant for slack:chat:write."
    except ApprovalDeniedError:
        return "The owner declined this message. Do not retry it."
    except ApprovalTimeoutError as err:
        return (
            f"Queued for owner approval (id {err.approval_id}). "
            "It will send if approved. Tell the user it is pending."
        )


@tool
def read_github_file(repo: str, path: str) -> str:
    """Read a file from a GitHub repository. repo is 'owner/name'."""
    try:
        result = av.call(
            platform="github",
            endpoint=f"/repos/{repo}/contents/{path}",
            scope="github:contents.read",
        )
        return str(result)
    except AccessDeniedError:
        return f"Not permitted to read {repo}."


@tool
def refund_payment(payment_intent: str, amount_cents: int) -> str:
    """Refund a Stripe payment. Amount is in cents."""
    # Destructive: check the decision BEFORE committing the user to a wait.
    decision = av.evaluate("stripe", "charge")
    if not decision:
        return "Refunds are not enabled for this agent."

    try:
        av.call(
            platform="stripe",
            endpoint="/v1/refunds",
            method="POST",
            scope="charge",
            data={"payment_intent": payment_intent, "amount": amount_cents},
            reason=f"Refund {amount_cents/100:.2f} on {payment_intent}",
        )
        return "Refund issued."
    except ApprovalTimeoutError as err:
        return f"Refund queued for approval (id {err.approval_id}). Not yet issued."
    except ApprovalDeniedError:
        return "The owner declined this refund."


TOOLS = [post_to_slack, read_github_file, refund_payment]

if __name__ == "__main__":
    # Wire TOOLS into whatever agent you already use — nothing here is
    # AgentValet-specific from LangChain's point of view; they are ordinary
    # tools that happen to be governed.
    #
    #   from langchain.agents import create_tool_calling_agent, AgentExecutor
    #   from langchain_openai import ChatOpenAI
    #   agent = create_tool_calling_agent(ChatOpenAI(model="gpt-4o"), TOOLS, prompt)
    #   AgentExecutor(agent=agent, tools=TOOLS).invoke({"input": "..."})
    #
    # Worth doing at startup: fail loudly if the agent is missing a grant it
    # needs, rather than discovering it mid-conversation with a user waiting.
    print("granted:", av.list_platforms())
    print("tools:", [t.name for t in TOOLS])
