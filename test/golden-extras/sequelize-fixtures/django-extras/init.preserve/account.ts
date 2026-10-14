import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';

export class Account extends Model<
  InferAttributes<Account>,
  InferCreationAttributes<Account>
> {
  declare id: CreationOptional<number>;
  declare email: string;

  static initModel(sequelize: Sequelize): typeof Account {
    Account.init(
      {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        email: { type: DataTypes.STRING(254), allowNull: false, unique: true },
      },
      {
        sequelize,
        modelName: 'Account',
        tableName: 'blog_account',
        timestamps: false,
      }
    );
    return Account;
  }
}
