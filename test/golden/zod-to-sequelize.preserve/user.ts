import {
  DataTypes,
  Model,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';

export class User extends Model<
  InferAttributes<User>,
  InferCreationAttributes<User>
> {
  declare id: number;

  static initModel(sequelize: Sequelize): typeof User {
    User.init(
      {
        id: { type: DataTypes.INTEGER, primaryKey: true },
      },
      { sequelize, modelName: 'User', tableName: 'User', timestamps: false }
    );
    return User;
  }
}
