import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';

export class Group extends Model<
  InferAttributes<Group>,
  InferCreationAttributes<Group>
> {
  declare id: CreationOptional<number>;
  declare title: CreationOptional<string | null>;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;

  static initModel(sequelize: Sequelize): typeof Group {
    Group.init(
      {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        title: DataTypes.STRING(255),
        createdAt: { type: DataTypes.DATE, allowNull: false },
        updatedAt: { type: DataTypes.DATE, allowNull: false },
      },
      { sequelize, modelName: 'Group', tableName: 'Groups', timestamps: true }
    );
    return Group;
  }
}
