const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const child_process = require('child_process');

// https://github.com/yinyongxian/file-and-folder-tool
// https://code.visualstudio.com/api
// https://marketplace.visualstudio.com/manage/publishers/file-and-folder-tool

// Publish: vsce package --> vsce publish

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
  const getActiveFile = () => vscode.window.activeTextEditor?.document?.fileName;

  const copyToClipboard = async (text) => {
    await vscode.env.clipboard.writeText(text);
    const lines = text.split("\n");
    if (lines.length === 1) {
      vscode.window.showInformationMessage(`Copied: ${text}`);
    } else {
      vscode.env.clipboard.writeText(lines[0].trim() + ", and more...");
    }
  };

  const commands = [
    {
      command: 'fft.copyFileName',
      callback: () => {
        const file = getActiveFile();
        if (file) copyToClipboard(path.basename(file));
      }
    },
    {
      command: 'fft.copyFileNameWithoutExtension',
      callback: () => {
        const file = getActiveFile();
        if (file) {
          const { name } = path.parse(file);
          copyToClipboard(name);
        }
      }
    },
    {
      command: 'fft.copyDirectoryPath',
      callback: () => {
        const file = getActiveFile();
        if (file) copyToClipboard(path.dirname(file));
      }
    },
    {
      command: 'fft.copyAllOpenFileNames',
      callback: () => {
        const paths = GetPaths();
        const filenames = paths.map(p => path.basename(p)).filter((v, i, a) => a.indexOf(v) === i).sort();
        vscode.env.clipboard.writeText(filenames.join("\n"))
      }
    },
    {
      command: 'fft.copyAllOpenFileNamesWithoutExtension',
      callback: () => {
        const paths = GetPaths();
        const filenames = paths.map(p => path.parse(p).name).filter((v, i, a) => a.indexOf(v) === i).sort();
        vscode.env.clipboard.writeText(filenames.join("\n"))
      }
    },
    {
      command: 'fft.copyAllOpenDirectoryPaths',
      callback: () => {
        const paths = GetPaths();
        const filenames = paths.map(p => path.dirname(p)).filter((v, i, a) => a.indexOf(v) === i).sort();
        vscode.env.clipboard.writeText(filenames.join("\n"))
      }
    },
    {
      command: 'fft.copyFile',
      callback: async () => {
        const file = getActiveFile();
        if (file) {
          await copyFilesToClipboard([file]);
        }
      }
    },
    {
      command: 'fft.copyAllOpenFiles',
      callback: async () => {
        await copyFilesToClipboard(GetPaths().sort());
      }
    }
  ];

  for (const cmd of commands) {
    const disposable = vscode.commands.registerCommand(cmd.command, cmd.callback);
    context.subscriptions.push(disposable);
  }
}

function GetPaths() {
	const fsPaths = vscode.workspace.textDocuments.map(doc => doc.uri.fsPath);
	const documentFsPaths = vscode.window.visibleTextEditors.map(editor => editor.document.uri.fsPath);
	const tabPaths = vscode.window.tabGroups.all.flatMap(({ tabs }) => tabs.map(tab => {
		if (tab.input instanceof vscode.TabInputText || tab.input instanceof vscode.TabInputNotebook) {
			return tab.input.uri.fsPath;
		}

		if (tab.input instanceof vscode.TabInputTextDiff || tab.input instanceof vscode.TabInputNotebookDiff) {
			return tab.input.original.fsPath;
		}

		return null;
	})).filter(Boolean);
	const distinctPaths = [...new Set([...fsPaths.concat(documentFsPaths).concat(tabPaths)]
	.filter(path => !path.startsWith("git") && 
					!path.endsWith("git") &&
					path !== null))];
	return distinctPaths;
}

async function copyFilesToClipboard(paths) {
	const files = paths.filter(file => file && fs.existsSync(file) && fs.statSync(file).isFile());
	if (files.length === 0) {
		vscode.window.showWarningMessage('No files to copy.');
		return;
	}

	const json = Buffer.from(JSON.stringify(files), 'utf8').toString('base64');
	const script = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class ClipboardFileCopy
{
    private const uint CF_HDROP = 15;
    private const uint GMEM_MOVEABLE = 0x0002;
    private const uint GMEM_ZEROINIT = 0x0040;

    [StructLayout(LayoutKind.Sequential)]
    private struct DROPFILES
    {
        public uint pFiles;
        public int x;
        public int y;
        public bool fNC;
        public bool fWide;
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool OpenClipboard(IntPtr hWndNewOwner);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool EmptyClipboard();

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetClipboardData(uint uFormat, IntPtr hMem);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool CloseClipboard();

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GlobalAlloc(uint uFlags, UIntPtr dwBytes);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GlobalLock(IntPtr hMem);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GlobalUnlock(IntPtr hMem);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GlobalFree(IntPtr hMem);

    public static void SetFiles(string[] files)
    {
        char zero = (char)0;
        string fileList = string.Join(zero.ToString(), files) + zero + zero;
        byte[] fileBytes = System.Text.Encoding.Unicode.GetBytes(fileList);
        int dropFilesSize = Marshal.SizeOf(typeof(DROPFILES));
        UIntPtr totalBytes = (UIntPtr)(dropFilesSize + fileBytes.Length);
        IntPtr hGlobal = GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, totalBytes);
        if (hGlobal == IntPtr.Zero)
        {
            throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        }

        bool clipboardOwnsMemory = false;
        try
        {
            IntPtr target = GlobalLock(hGlobal);
            if (target == IntPtr.Zero)
            {
                throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            }

            try
            {
                DROPFILES dropFiles = new DROPFILES
                {
                    pFiles = (uint)dropFilesSize,
                    x = 0,
                    y = 0,
                    fNC = false,
                    fWide = true
                };
                Marshal.StructureToPtr(dropFiles, target, false);
                Marshal.Copy(fileBytes, 0, IntPtr.Add(target, dropFilesSize), fileBytes.Length);
            }
            finally
            {
                GlobalUnlock(hGlobal);
            }

            if (!OpenClipboard(IntPtr.Zero))
            {
                throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            }

            try
            {
                if (!EmptyClipboard())
                {
                    throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
                }

                if (SetClipboardData(CF_HDROP, hGlobal) == IntPtr.Zero)
                {
                    throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
                }

                clipboardOwnsMemory = true;
            }
            finally
            {
                CloseClipboard();
            }
        }
        finally
        {
            if (!clipboardOwnsMemory)
            {
                GlobalFree(hGlobal);
            }
        }
    }
}
"@
$json = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${json}'))
$files = [string[]](ConvertFrom-Json -InputObject $json)
[ClipboardFileCopy]::SetFiles($files)
`;
	const encodedScript = Buffer.from(script, 'utf16le').toString('base64');

	try {
		await new Promise((resolve, reject) => {
			const child = child_process.spawn('powershell.exe', [
				'-NoProfile',
				'-NonInteractive',
				'-STA',
				'-EncodedCommand',
				encodedScript
			]);

			let stderr = '';
			child.stderr.on('data', data => stderr += data.toString());
			child.on('error', reject);
			child.on('close', code => {
				if (code === 0) {
					resolve();
				} else {
					reject(new Error(stderr || `Copy files failed with exit code ${code}.`));
				}
			});
		});
		vscode.window.showInformationMessage(`Copied ${files.length} file${files.length === 1 ? '' : 's'}.`);
	} catch (error) {
		vscode.window.showErrorMessage(`Copy files failed: ${error.message}`);
	}
}

function deactivate() {}

module.exports = {
  activate,
  deactivate
};
