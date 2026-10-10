fn main() {
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args.as_slice() == ["contracts"] {
        println!("{}", ranking_contracts::model::metadata());
        return;
    }
    if args.first().is_some_and(|command| command == "fetch") {
        if let Err(error) = ranking_fetch::run(&args[1..]) {
            eprintln!("fetch: {error}");
            std::process::exit(1);
        }
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
    if let [command, input, output] = args.as_slice()
        && command == "storage"
    {
        if let Err(error) = ranking_storage::run(input, output) {
            eprintln!("storage: {error}");
            std::process::exit(1);
        }
        return;
    }
    eprintln!(
        "usage: ranking-refresh contracts | raw-source <input.json> <output.json> | storage <input.json> <output.json> | fetch [flags]"
    );
    std::process::exit(2);
}
