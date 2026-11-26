using System;
using System.Globalization;
using System.Linq;
using System.Text;
using System.Threading;
using LibreHardwareMonitor.Hardware;

namespace SmartDiskSensors
{
    internal sealed class UpdateVisitor : IVisitor
    {
        public void VisitComputer(IComputer computer) { computer.Traverse(this); }
        public void VisitHardware(IHardware hardware) { hardware.Update(); foreach (var sub in hardware.SubHardware) sub.Accept(this); }
        public void VisitSensor(ISensor sensor) { }
        public void VisitParameter(IParameter parameter) { }
    }

    internal static class Program
    {
        static string Q(string s)
        {
            var b = new StringBuilder("\"");
            foreach (var ch in s ?? "")
            {
                if (ch == '"' || ch == '\\') b.Append('\\').Append(ch);
                else if (ch < 0x20) b.Append("\\u").Append(((int)ch).ToString("x4"));
                else b.Append(ch);
            }
            return b.Append('"').ToString();
        }

        static void Hardware(StringBuilder o, IHardware h, string parent)
        {
            foreach (var s in h.Sensors)
            {
                if (s.Value == null || float.IsNaN(s.Value.Value) || float.IsInfinity(s.Value.Value)) continue;
                if (o.Length > 1) o.Append(',');
                o.Append("{\"hw\":").Append(Q(h.HardwareType.ToString()))
                 .Append(",\"part\":").Append(Q(parent ?? h.Name))
                 .Append(",\"chip\":").Append(Q(parent != null ? h.Name : ""))
                 .Append(",\"type\":").Append(Q(s.SensorType.ToString()))
                 .Append(",\"name\":").Append(Q(s.Name))
                 .Append(",\"value\":").Append(s.Value.Value.ToString("0.###", CultureInfo.InvariantCulture)).Append('}');
            }
            foreach (var sub in h.SubHardware) Hardware(o, sub, parent ?? h.Name);
        }

        static string Snapshot(Computer computer)
        {
            var o = new StringBuilder("[");
            foreach (var h in computer.Hardware) Hardware(o, h, null);
            return o.Append(']').ToString();
        }

        // No arguments: one reading. "--watch 2000": a reading every 2000 ms (one JSON line each) until stdin closes
        // or the process is ended; used by the burn-in test so the driver is opened only once.
        static int Main(string[] args)
        {
            var computer = new Computer { IsCpuEnabled = true, IsGpuEnabled = true, IsMotherboardEnabled = true, IsMemoryEnabled = true, IsControllerEnabled = true };
            int watch = 0;
            if (args.Length >= 2 && args[0] == "--watch") int.TryParse(args[1], out watch);
            try
            {
                Console.OutputEncoding = Encoding.UTF8;
                computer.Open();
                var v = new UpdateVisitor();
                computer.Accept(v);
                Thread.Sleep(1000);   // loads and some clocks need two samples
                computer.Accept(v);
                if (watch <= 0)
                {
                    Console.WriteLine("{\"ok\":true,\"sensors\":" + Snapshot(computer) + "}");
                    return 0;
                }
                watch = Math.Max(500, Math.Min(60000, watch));
                // Stop when the parent closes our stdin (smartPC quit or the test ended).
                var stdin = new Thread(() => { try { while (Console.In.ReadLine() != null) { } } catch { } Environment.Exit(0); }) { IsBackground = true };
                stdin.Start();
                while (true)
                {
                    Console.WriteLine("{\"ok\":true,\"t\":" + DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + ",\"sensors\":" + Snapshot(computer) + "}");
                    Console.Out.Flush();
                    Thread.Sleep(watch);
                    computer.Accept(v);
                }
            }
            catch (Exception e)
            {
                Console.WriteLine("{\"ok\":false,\"error\":" + Q(e.Message) + "}");
                return 1;
            }
            finally { try { computer.Close(); } catch { } }
        }
    }
}
