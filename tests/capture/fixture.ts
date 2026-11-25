import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** A small Flask codebase to capture: notes kept in a table, two routes, their tests, a logo, a README. */
export const NOTES_APP: Record<string, string | Buffer> = {
  "README.md": "# Notes\n\nKeep short notes.\n",
  "requirements.txt": "flask==3.0.3\nflask-sqlalchemy==3.1.1\n",
  "app/__init__.py": ["from flask import Flask", "from .routes import bp", "", "def create_app():", "    app = Flask(__name__)", "    app.register_blueprint(bp)", "    return app", ""].join("\n"),
  "app/models.py": ["from flask_sqlalchemy import SQLAlchemy", "", "db = SQLAlchemy()", "", "class Note(db.Model):", '    __tablename__ = "notes"', "    id = db.Column(db.Integer, primary_key=True)", ""].join("\n"),
  "app/routes.py": [
    "from flask import Blueprint, request",
    "from .models import Note, db",
    "",
    'bp = Blueprint("notes", __name__)',
    "",
    '@bp.route("/notes", methods=["POST"])',
    "def add_note():",
    '    note = Note(text=request.json["text"])',
    "    db.session.add(note)",
    '    return {"id": note.id}, 201',
    "",
    '@bp.get("/notes")',
    "def list_notes():",
    "    return [n.text for n in Note.query.order_by(Note.id.desc())]",
    "",
  ].join("\n"),
  "app/static/logo.png": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]),
  "tests/test_notes.py": ["def test_add_note(client):", '    assert client.post("/notes", json={"text": "hi"}).status_code == 201', "", "def test_list_notes(client):", '    assert client.get("/notes").status_code == 200', ""].join("\n"),
};

/** Write a codebase into a new temporary folder - a git repo when asked - and give back the folder. */
export function writeCodebase(files: Record<string, string | Buffer> = NOTES_APP, options: { git?: boolean } = {}): string {
  const root = mkdtempSync(join(tmpdir(), "turri-capture-"));
  for (const [path, content] of Object.entries(files)) {
    const file = join(root, ...path.split("/"));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  if (options.git === true) spawnSync("git", ["init", "-q"], { cwd: root });
  return root;
}
