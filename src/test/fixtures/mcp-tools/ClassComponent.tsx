import React, { Component } from 'react';

interface Props {
  title: string;
}

interface State {
  count: number;
}

class ClassComponent extends Component<Props, State> {
  state = {
    count: 0
  };

  increment = () => {
    this.setState({ count: this.state.count + 1 });
  };

  render() {
    return (
      <div>
        <h1>{this.props.title}</h1>
        <p>Count: {this.state.count}</p>
        <button onClick={this.increment}>Increment</button>
      </div>
    );
  }
}

export default ClassComponent;
