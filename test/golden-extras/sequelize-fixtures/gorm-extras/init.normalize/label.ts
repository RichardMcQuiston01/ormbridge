import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';

export class Label extends Model<
  InferAttributes<Label>,
  InferCreationAttributes<Label>
> {
  declare id: CreationOptional<string>;
  declare name: string;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;

  static initModel(sequelize: Sequelize): typeof Label {
    Label.init(
      {
        id: {
          type: DataTypes.UUID,
          primaryKey: true,
          defaultValue: DataTypes.UUIDV4,
        },
        name: { type: DataTypes.STRING(40), allowNull: false, unique: true },
        createdAt: { type: DataTypes.DATE, allowNull: false },
        updatedAt: { type: DataTypes.DATE, allowNull: false },
      },
      {
        sequelize,
        modelName: 'Label',
        tableName: 'label',
        timestamps: true,
        underscored: true,
      }
    );
    return Label;
  }
}
