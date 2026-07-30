import SwiftUI

struct ContentView: View {

    @ObservedObject var model: AppModel

    var body: some View {
        ZStack {
            // Matches the web app's --bg so there is no white flash between the
            // launch screen and the first paint.
            Color(red: 0.07, green: 0.07, blue: 0.10)
                .ignoresSafeArea()

            switch model.state {
            case .starting:
                ProgressView()
                    .tint(.white)
                    .controlSize(.large)

            case .local(let url), .remote(let url):
                WebViewContainer(source: url)
                    .ignoresSafeArea(edges: .bottom)

            case .failed(let message):
                VStack(spacing: 12) {
                    Text("Aloud couldn't start")
                        .font(.headline)
                        .foregroundStyle(.white)
                    Text(message)
                        .font(.footnote)
                        .foregroundStyle(.white.opacity(0.7))
                        .multilineTextAlignment(.center)
                }
                .padding(32)
            }
        }
    }
}
