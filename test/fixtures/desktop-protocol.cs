using System;
using System.Text;
using System.Web.Script.Serialization;
class ProtocolFixture {
    static int Main(string[] args) {
        Console.InputEncoding = new UTF8Encoding(false);
        Console.OutputEncoding = new UTF8Encoding(false);
        if (Array.IndexOf(args, "--version") >= 0) { Console.WriteLine("fixture 1.0"); return 0; }
        if (Array.IndexOf(args, "--echo-args") >= 0) { Console.WriteLine(new JavaScriptSerializer().Serialize(args)); return 0; }
        string line;
        while ((line = Console.ReadLine()) != null) Console.WriteLine(line);
        Console.Error.Write("fixture-stderr");
        return 7;
    }
}
