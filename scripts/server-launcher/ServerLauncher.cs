using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;

internal static class ServerLauncher {
  [STAThread]
  private static void Main() {
    try {
      string script = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "Start-Server.ps1");
      Process.Start(new ProcessStartInfo {
        FileName = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), @"WindowsPowerShell\v1.0\powershell.exe"),
        Arguments = "-NoProfile -File \"" + script + "\"",
        UseShellExecute = false,
        CreateNoWindow = true,
        WindowStyle = ProcessWindowStyle.Hidden
      });
    } catch (Exception error) {
      MessageBox.Show(error.Message, "CLI Proxy Server", MessageBoxButtons.OK, MessageBoxIcon.Error);
    }
  }
}
