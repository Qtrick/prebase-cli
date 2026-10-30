using System;
using csharp_app.Services;

namespace csharp_app
{
    class Program
    {
        static void Main(string[] args)
        {
            DataService svc = new DataService();
            Console.WriteLine(svc.GetData());
        }
    }
}
