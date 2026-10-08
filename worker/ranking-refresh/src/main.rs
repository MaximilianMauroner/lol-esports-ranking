fn main() {
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args.as_slice() == ["contracts"] {
        println!("{}", ranking_contracts::model::metadata());
        return;
    }
    if let [command, input, output] = args.as_slice()
        && command == "raw-source"
    {
        if let Err(error) = ranking_raw_source::run(input, output) {
            eprintln!("raw-source: {error}");
            std::process::exit(1);
        }
        return;
    }
    eprintln!("usage: ranking-refresh contracts | raw-source <input.json> <output.json>");
    std::process::exit(2);
}
