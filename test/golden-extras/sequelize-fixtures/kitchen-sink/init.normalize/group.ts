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
  declare id: CreationOptional<string>;
  declare name: string;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;

  declare friends?: NonAttribute<Group[]>;
  declare friendOf?: NonAttribute<Group[]>;

  static initModel(sequelize: Sequelize): typeof Group {
    Group.init(
      {
        id: {
          type: DataTypes.UUID,
          primaryKey: true,
          defaultValue: DataTypes.UUIDV4,
        },
        name: { type: DataTypes.STRING(40), allowNull: false },
        createdAt: { type: DataTypes.DATE, allowNull: false },
        updatedAt: { type: DataTypes.DATE, allowNull: false },
      },
      {
        sequelize,
        modelName: 'Group',
        tableName: 'group',
        timestamps: true,
        underscored: true,
      }
    );
    return Group;
  }
}
