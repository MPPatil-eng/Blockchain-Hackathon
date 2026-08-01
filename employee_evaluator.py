"""
employee_evaluator.py  —  ProofPay AI · LLM Evaluation Module
══════════════════════════════════════════════════════════════════════════════
Provides two usage modes:

  1. CLI (direct):
       python employee_evaluator.py
       python main.py

  2. Imported by server.js companion (via child_process spawn) — kept
     as a standalone fallback if the Node.js Groq client has issues.

All evaluation logic uses the Groq API (OpenAI-compatible) via the
GROQ_API_KEY environment variable.
══════════════════════════════════════════════════════════════════════════════
"""

import os
import json
import sys
import pandas as pd
from openai import OpenAI
from dotenv import load_dotenv

load_dotenv()

CSV_PATH = os.path.join(os.path.dirname(__file__), "employees.csv")


# ── Load employee by name AND company ID ─────────────────────────────────────
def load_employee(name: str, company_id: str) -> dict | None:
    """Return the employee row dict or None if not found."""
    df = pd.read_csv(CSV_PATH)
    match = df[
        (df["Employee Name"].str.lower() == name.lower()) &
        (df["Company ID"].str.upper() == company_id.upper())
    ]
    if match.empty:
        return None
    return match.iloc[0].to_dict()


def list_all_employees() -> list[dict]:
    """Return all employee rows as a list of dicts."""
    df = pd.read_csv(CSV_PATH)
    return df.to_dict(orient="records")


# ── Build the LLM prompt ──────────────────────────────────────────────────────
def _build_prompt(emp: dict) -> str:
    return f"""You are a senior HR performance evaluation expert with 15 years of experience.
Analyze this employee's last 3 months of work data and give a detailed, honest, human-sounding evaluation.
Be specific — mention actual numbers from their data in your feedback.

Employee: {emp["Employee Name"]}
Company ID: {emp["Company ID"]}
Average Work Hours Per Day: {emp["Avg Work Hours/Day"]} hrs
Average Extra Time Per Day: {emp["Avg Extra Time (Hours/Day)"]} hrs
Leaves Taken (Last 3 Months): {emp["Leaves (Last 3 Months)"]}
Projects Completed (Last 3 Months): {emp["Projects Completed (Last 3 Months)"]}

Scoring guide:
- Work hours above 8/day is good, below 7 is concerning
- Extra time shows dedication but over 2 hrs/day may suggest inefficiency
- Leaves above 6 in 3 months is high
- Projects completed is the strongest signal of output

Return ONLY valid JSON, no markdown fences, no extra text:
{{
  "score": <number 0-100>,
  "summary": "<2-3 sentences, mention specific numbers>",
  "strengths": ["<strength with specific data>", "<strength>", "<strength>"],
  "weaknesses": ["<weakness with specific data>", "<weakness>"],
  "improvement_suggestions": ["<specific actionable suggestion>", "<suggestion>", "<suggestion>"]
}}"""


# ── Send to Groq (OpenAI-compatible) ─────────────────────────────────────────
def evaluate_with_llm(emp: dict) -> dict:
    """
    Call the Groq LLM and return a structured evaluation dict.
    Falls back to a mock response if no API key is configured.
    """
    api_key = os.environ.get("GROQ_API_KEY")

    if not api_key:
        print("\n⚠  No GROQ_API_KEY in .env — returning mock response.\n")
        return {
            "score": 74,
            "summary": "Mock response. Add GROQ_API_KEY to .env for real AI feedback.",
            "strengths": ["Shows up regularly", "Completed some projects"],
            "weaknesses": ["High leave count", "Low project output"],
            "improvement_suggestions": [
                "Reduce unplanned leaves",
                "Set weekly project goals",
                "Discuss workload with manager",
            ],
        }

    client = OpenAI(
        api_key=api_key,
        base_url="https://api.groq.com/openai/v1",
    )
    response = client.chat.completions.create(
        model="llama-3.3-70b-versatile",
        messages=[{"role": "user", "content": _build_prompt(emp)}],
        max_tokens=700,
        temperature=0.7,
    )

    raw = response.choices[0].message.content.strip()

    # Strip ```json ``` if the model wraps it
    if raw.startswith("```"):
        raw = raw.split("```")[1]
        if raw.startswith("json"):
            raw = raw[4:]

    return json.loads(raw.strip())


# ── Pretty-print result ───────────────────────────────────────────────────────
def print_result(emp: dict, result: dict) -> None:
    print("\n" + "=" * 55)
    print(f"  Employee  : {emp['Employee Name']}")
    print(f"  Company ID: {emp['Company ID']}")
    print(f"  Score     : {result['score']}/100")
    print("=" * 55)
    print(f"\nSummary:\n  {result['summary']}")
    print("\nStrengths:")
    for s in result["strengths"]:
        print(f"  - {s}")
    print("\nWeaknesses:")
    for w in result["weaknesses"]:
        print(f"  - {w}")
    print("\nImprovement Suggestions:")
    for i in result["improvement_suggestions"]:
        print(f"  - {i}")
    print()


# ── Save result ───────────────────────────────────────────────────────────────
def save_result(emp: dict, result: dict) -> None:
    output = {
        "name":                    emp["Employee Name"],
        "company_id":              emp["Company ID"],
        "score":                   result["score"],
        "summary":                 result["summary"],
        "strengths":               result["strengths"],
        "weaknesses":              result["weaknesses"],
        "improvement_suggestions": result["improvement_suggestions"],
    }
    out_path = os.path.join(os.path.dirname(__file__), "evaluation_result.json")
    with open(out_path, "w") as f:
        json.dump(output, f, indent=2)
    print(f"✅ Saved to evaluation_result.json\n")


# ── CLI entrypoint ─────────────────────────────────────────────────────────────
def main() -> None:
    """Interactive CLI: prompt for name + company ID, evaluate, print + save."""
    print("\n── Employee Performance Evaluator ──\n")
    name       = input("Enter employee name : ").strip()
    company_id = input("Enter company ID    : ").strip()

    emp = load_employee(name, company_id)
    if not emp:
        print("\n❌ Employee not found. Check name and company ID match the CSV.\n")
        sys.exit(1)

    print("\n⏳ Evaluating with AI…")
    result = evaluate_with_llm(emp)

    print_result(emp, result)
    save_result(emp, result)


# ── JSON mode (called by external tools) ─────────────────────────────────────
# Usage:  python employee_evaluator.py --json <name> <companyId>
# Prints a single JSON object to stdout and exits.
if __name__ == "__main__":
    if len(sys.argv) == 4 and sys.argv[1] == "--json":
        _name = sys.argv[2]
        _cid  = sys.argv[3]
        _emp  = load_employee(_name, _cid)
        if not _emp:
            print(json.dumps({"error": "Employee not found"}))
            sys.exit(1)
        _result = evaluate_with_llm(_emp)
        _result["name"]       = _emp["Employee Name"]
        _result["company_id"] = _emp["Company ID"]
        print(json.dumps(_result))
    else:
        main()