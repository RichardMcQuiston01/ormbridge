import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type NonAttribute,
  type Sequelize,
} from 'sequelize';

export class Group extends Model<
  InferAttributes<Group>,
  InferCreationAttributes<Group>
> {
  declare id: CreationOptional<number>;
  declare name: string;

  declare friends?: NonAttribute<Group[]>;
  declare friend_of?: NonAttribute<Group[]>;

  static initModel(sequelize: Sequelize): typeof Group {
    Group.init(
      {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        name: { type: DataTypes.STRING(40), allowNull: false },
      },
      { sequelize, modelName: 'Group', tableName: 'groups', timestamps: false }
    );
    return Group;
  }
}
