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

        static int Main()
        {
            var computer = new Computer { IsCpuEnabled = true, IsGpuEnabled = true, IsMotherboardEnabled = true, IsMemoryEnabled = true, IsControllerEnabled = true };
            try
            {
                computer.Open();
                var v = new UpdateVisitor();
                computer.Accept(v);
                Thread.Sleep(1000);   // loads and some clocks need two samples
                computer.Accept(v);
                var o = new StringBuilder("[");
                foreach (var h in computer.Hardware) Hardware(o, h, null);
                o.Append(']');
                Console.OutputEncoding = Encoding.UTF8;
                Console.WriteLine("{\"ok\":true,\"sensors\":" + o + "}");
                return 0;
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
