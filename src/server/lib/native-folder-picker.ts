import { execFile } from 'node:child_process'

interface CommandResult {
  stdout: string
  stderr: string
}

function execFileAsync(command: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 120_000 }, (error, stdout, stderr) => {
      if (error) {
        reject(error)
        return
      }

      resolve({ stdout, stderr })
    })
  })
}

async function tryPickWith(command: string, args: string[]) {
  const result = await execFileAsync(command, args)
  return result.stdout.trim()
}

async function pickOnMac() {
  return tryPickWith('osascript', [
    '-e',
    'POSIX path of (choose folder with prompt "Select project folder")',
  ])
}

async function pickOnWindows() {
  return tryPickWith('powershell', [
    '-NoProfile',
    '-Command',
    [
      'Add-Type -AssemblyName System.Windows.Forms',
      '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
      '$dialog.Description = "Select project folder"',
      'if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $dialog.SelectedPath }',
    ].join('; '),
  ])
}

async function pickOnLinux() {
  const attempts: Array<() => Promise<string>> = [
    () => tryPickWith('zenity', ['--file-selection', '--directory', '--title=Select project folder']),
    () => tryPickWith('kdialog', ['--getexistingdirectory', '.', '--title', 'Select project folder']),
    () =>
      tryPickWith('python3', [
        '-c',
        [
          'import tkinter as tk',
          'from tkinter import filedialog',
          'root = tk.Tk()',
          'root.withdraw()',
          'root.attributes("-topmost", True)',
          'path = filedialog.askdirectory(title="Select project folder")',
          'print(path)',
        ].join('; '),
      ]),
  ]

  for (const attempt of attempts) {
    try {
      const path = await attempt()
      if (path) {
        return path
      }
    } catch {
      continue
    }
  }

  return ''
}

export async function pickProjectFolder() {
  let path = ''

  if (process.platform === 'darwin') {
    path = await pickOnMac()
  } else if (process.platform === 'win32') {
    path = await pickOnWindows()
  } else {
    path = await pickOnLinux()
  }

  if (!path) {
    throw new Error('Native folder picker is unavailable here. Enter the path manually.')
  }

  return path
}
